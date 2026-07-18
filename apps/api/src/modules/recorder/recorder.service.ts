import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, VoiceRecording } from '@prisma/client';
import {
  CreateRecordingInput,
  FileDto,
  VoiceLanguage,
  VoiceRecordingDto,
  VoiceRecordingSource,
  VoiceTranscriptStatus,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../../core/files/files.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { VoiceService } from '../../core/voice/voice.service';
import {
  CallsRecordingRegistry,
  type CallRecordingReadyContext,
} from '../../core/calls/calls-recording.registry';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Диктофон — потребитель голосового движка (прото-Plaud без железки): запись
 * собрания/лекции → транскрипт со спикерами. Файл привязан FileLink'ом
 * refType='voice_recording' (owner-only; без привязки файл приберёт orphan-sweep).
 * Транскрипция и статусы — через API движка VoiceService (в таблицы core/voice
 * напрямую не ходим); файловые связи — через API движка files.
 * Будущие источники: SuperTerminal6 (source='terminal'), запись звонков LiveKit.
 */
@Injectable()
export class RecorderService implements OnModuleInit {
  private readonly logger = new Logger(RecorderService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly voice: VoiceService,
    private readonly callsRecordings: CallsRecordingRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.filesRegistry.register(
      'voice_recording',
      {
        canView: async (viewerId, refId) => {
          const rec = await this.db.voiceRecording.findUnique({ where: { id: refId }, select: { ownerId: true } });
          return rec?.ownerId === viewerId;
        },
        canAttach: async (userId, refId) => {
          const rec = await this.db.voiceRecording.findUnique({ where: { id: refId }, select: { ownerId: true } });
          return rec?.ownerId === userId;
        },
      },
      { allowedProfiles: ['dictaphone', 'voice_message'] },
    );

    // «Журнал звонков»: движок звонков зовёт хук на КАЖДОГО клейманта готовой
    // записи (refType='chat' — звонки мессенджера). Файл ОБЩИЙ (владелец —
    // включивший запись), у каждого клейманта своя VoiceRecording → общий транскрипт.
    this.callsRecordings.register('chat', {
      onReady: (ctx) => this.deliverCallRecording(ctx),
    });
  }

  /**
   * Идемпотентная доставка записи звонка клейманту. Идемпотентность держится на
   * @@unique([callRecordingId, ownerId]) + на НАЛИЧИИ привязанного файла: P2002 сам по
   * себе НЕ значит «доставлено» — прошлая попытка могла упасть между create и linkFile
   * (строка без файла = пустая карточка в «Журнале звонков»). Поэтому на дубль
   * перечитываем строку и до-линковываем файл, если его ещё нет.
   */
  private async deliverCallRecording(ctx: CallRecordingReadyContext): Promise<void> {
    let row: VoiceRecording | null = null;
    try {
      row = await this.db.voiceRecording.create({
        data: {
          ownerId: ctx.claimantUserId,
          title: callTitle(ctx.startedAt),
          source: 'call',
          callRecordingId: ctx.recordingId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        row = await this.db.voiceRecording.findUnique({
          where: { callRecordingId_ownerId: { callRecordingId: ctx.recordingId, ownerId: ctx.claimantUserId } },
        });
      } else {
        throw err;
      }
    }
    if (!row) return; // не смогли ни создать, ни найти — крон доретраит

    // Файл уже привязан? (успешная прошлая доставка) — тогда доставка завершена.
    const linked = await this.files.getLinkedFileIds('voice_recording', row.id);
    if (linked.length) return;

    const created = row;
    try {
      // linkFile НЕ требует uploaderId (файл чужой — включившего запись): гейт —
      // canAttach резолвера voice_recording (владелец строки = клеймант)
      await this.files.linkFile(ctx.claimantUserId, ctx.fileId, 'voice_recording', created.id);
    } catch (err) {
      // Компенсация: строка без файла бессмысленна; клейм останется недоставленным — крон доретраит
      await this.db.voiceRecording.delete({ where: { id: created.id } }).catch(() => undefined);
      throw err;
    }
    await this.notifications
      .notify(
        ctx.claimantUserId,
        'call.recording.ready',
        { title: row.title, recordingId: row.id, fileId: ctx.fileId },
        { actionUrl: `/recorder?id=${row.id}` },
      )
      .catch((err) =>
        this.logger.warn(`notify call.recording.ready: ${err instanceof Error ? err.message : err}`),
      );
  }

  /** Список записей владельца (новые сверху; объём Диктофона мал — без курсора в v1) */
  async list(userId: string): Promise<VoiceRecordingDto[]> {
    const rows = await this.db.voiceRecording.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (!rows.length) return [];

    const filesByRec = await this.files.listLinked('voice_recording', rows.map((r) => r.id));
    const fileIds: string[] = [];
    for (const list of filesByRec.values()) for (const f of list) fileIds.push(f.id);
    const transcriptByFile = await this.voice.getStatusesForFiles(fileIds);

    return rows.map((r) => {
      const file = filesByRec.get(r.id)?.[0] ?? null;
      const tr = file ? transcriptByFile.get(file.id) ?? null : null;
      return this.serialize(r, file, tr?.status ?? null, tr?.durationMs ?? null);
    });
  }

  async create(userId: string, input: CreateRecordingInput): Promise<VoiceRecordingDto> {
    const [file] = await this.files.getOwnedReadyFiles(userId, [input.fileId]);
    if (file.kind !== 'audio') throw new BadRequestException('Диктофон принимает только аудио');

    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.voiceRecording.create({
        data: {
          ownerId: userId,
          title: input.title ?? defaultTitle(),
          source: input.source ?? 'upload',
          language: input.language ?? null,
        },
      });
      await this.files.linkManyInTx(tx, userId, [input.fileId], 'voice_recording', created.id);
      return created;
    });
    return this.serialize(row, file, null, null);
  }

  /** Переименование: лёгкий ответ (веб патчит title в кэше списка, полный DTO не нужен) */
  async rename(userId: string, id: string, title: string): Promise<{ id: string; title: string }> {
    await this.assertOwner(userId, id);
    const row = await this.db.voiceRecording.update({ where: { id }, data: { title } });
    return { id: row.id, title: row.title };
  }

  /** Удаление: отвязка (движок реапит осиротевший файл) → транскрипты ТОЛЬКО прибранных файлов → строка */
  async remove(userId: string, id: string): Promise<void> {
    await this.assertOwner(userId, id);
    const fileIds = await this.files.getLinkedFileIds('voice_recording', id);
    await this.files.unlinkAllForRef('voice_recording', id);
    // Транскрипт умирает только вместе с файлом: файл, живущий вложением чата,
    // сохраняет общий транскрипт («1 файл = 1 транскрипт навсегда»)
    await this.voice.deleteForReapedFiles(fileIds);
    await this.db.voiceRecording.delete({ where: { id } });
  }

  private async assertOwner(userId: string, id: string): Promise<VoiceRecording> {
    const row = await this.db.voiceRecording.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Запись не найдена');
    if (row.ownerId !== userId) throw new ForbiddenException('Это не ваша запись');
    return row;
  }

  private serialize(
    row: VoiceRecording,
    file: FileDto | null,
    transcriptStatus: VoiceTranscriptStatus | null,
    transcriptDurationMs: number | null,
  ): VoiceRecordingDto {
    const fileMeta = (file?.meta as Record<string, unknown> | null) ?? {};
    const metaDuration = typeof fileMeta.durationMs === 'number' ? fileMeta.durationMs : null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      title: row.title,
      source: row.source as VoiceRecordingSource,
      language: (row.language as VoiceLanguage | null) ?? null,
      // Длительность живёт у файла (конвейер) с добором из транскрипта (STT посчитал);
      // своей колонки-снимка у записи нет — один источник правды
      durationMs: metaDuration ?? transcriptDurationMs,
      createdAt: row.createdAt.toISOString(),
      file,
      transcriptStatus,
    };
  }
}

function defaultTitle(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `Запись ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function callTitle(startedAt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Звонок ${p(startedAt.getDate())}.${p(startedAt.getMonth() + 1)}.${startedAt.getFullYear()} ${p(startedAt.getHours())}:${p(startedAt.getMinutes())}`;
}
