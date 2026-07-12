import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { VoiceRecording } from '@prisma/client';
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

/**
 * Диктофон — потребитель голосового движка (прото-Plaud без железки): запись
 * собрания/лекции → транскрипт со спикерами. Файл привязан FileLink'ом
 * refType='voice_recording' (owner-only; без привязки файл приберёт orphan-sweep).
 * Транскрипция — через общую поверхность /voice/* (одна точка движка).
 * Будущие источники: SuperTerminal6 (source='terminal'), запись звонков LiveKit.
 */
@Injectable()
export class RecorderService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly filesRegistry: FilesRefRegistry,
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
    const transcripts = fileIds.length
      ? await this.db.voiceTranscript.findMany({
          where: { fileId: { in: fileIds } },
          select: { fileId: true, status: true },
        })
      : [];
    const statusByFile = new Map(transcripts.map((t) => [t.fileId, t.status as VoiceTranscriptStatus]));

    return rows.map((r) => {
      const file = filesByRec.get(r.id)?.[0] ?? null;
      return this.serialize(r, file, file ? statusByFile.get(file.id) ?? null : null);
    });
  }

  async create(userId: string, input: CreateRecordingInput): Promise<VoiceRecordingDto> {
    const [file] = await this.files.getOwnedReadyFiles(userId, [input.fileId]);
    if (file.kind !== 'audio') throw new BadRequestException('Диктофон принимает только аудио');

    const meta = (file.meta as Record<string, unknown> | null) ?? {};
    const durationMs = typeof meta.durationMs === 'number' ? meta.durationMs : null;
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.voiceRecording.create({
        data: {
          ownerId: userId,
          title: input.title ?? defaultTitle(),
          source: input.source ?? 'upload',
          language: input.language ?? null,
          durationMs,
        },
      });
      await this.files.linkManyInTx(tx, userId, [input.fileId], 'voice_recording', created.id);
      return created;
    });
    return this.serialize(row, file, null);
  }

  async rename(userId: string, id: string, title: string): Promise<VoiceRecordingDto> {
    await this.assertOwner(userId, id);
    const row = await this.db.voiceRecording.update({ where: { id }, data: { title } });
    const file = (await this.files.listLinked('voice_recording', [id])).get(id)?.[0] ?? null;
    const status = file
      ? ((await this.db.voiceTranscript.findUnique({ where: { fileId: file.id }, select: { status: true } }))
          ?.status as VoiceTranscriptStatus | undefined) ?? null
      : null;
    return this.serialize(row, file, status);
  }

  /** Удаление: транскрипты файлов → отвязка (движок реапит файл и возвращает квоту) → строка */
  async remove(userId: string, id: string): Promise<void> {
    await this.assertOwner(userId, id);
    const links = await this.db.fileLink.findMany({
      where: { refType: 'voice_recording', refId: id },
      select: { fileId: true },
    });
    const fileIds = [...new Set(links.map((l) => l.fileId))];
    if (fileIds.length) {
      await this.db.voiceTranscript.deleteMany({ where: { fileId: { in: fileIds } } });
    }
    await this.files.unlinkAllForRef('voice_recording', id);
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
  ): VoiceRecordingDto {
    const fileMeta = (file?.meta as Record<string, unknown> | null) ?? {};
    const metaDuration = typeof fileMeta.durationMs === 'number' ? fileMeta.durationMs : null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      title: row.title,
      source: row.source as VoiceRecordingSource,
      language: (row.language as VoiceLanguage | null) ?? null,
      durationMs: row.durationMs ?? metaDuration,
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
