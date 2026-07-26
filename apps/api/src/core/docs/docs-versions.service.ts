import { HttpException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import {
  DOCS_JOB_TYPES,
  DOCS_LIMITS,
  DOCS_QUEUE,
  documentFormatByExt,
  type DocumentVersionDto,
  type DocumentVersionReason,
  type FileOwnerType,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../files/files.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';

type Tx = Prisma.TransactionClient;

/**
 * Вехи-версии документа: неизменяемые снимки живого черновика. Режутся при уходе
 * последнего редактора (Unlock/жнец) и по кнопке «Сохранить версию».
 *
 * Порядок без висячих состояний: строка версии в статусе pending и джоб её материализации
 * создаются В ОДНОЙ транзакции с закрытием сессии (transactional outbox) — коммит значит
 * «веха будет», откат не оставляет ни строки, ни джоба.
 */
@Injectable()
export class DocsVersionsService implements OnModuleInit {
  private readonly logger = new Logger(DocsVersionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(
      DOCS_JOB_TYPES.milestone,
      (payload) => this.materialize(String(payload.documentId)),
      {
        // СВОЯ очередь: снимок тянет байты документа и жмёт их в хранилище, то есть
        // держит слот секундами. В 'default' такие типы подпирали бы латентно
        // чувствительные (уведомления, напоминания, плашки чатов).
        queue: DOCS_QUEUE,
        queueConcurrency: DOCS_LIMITS.queueConcurrency,
        maxAttempts: DOCS_LIMITS.milestoneMaxAttempts,
        backoffBaseMs: DOCS_LIMITS.milestoneBackoffBaseMs,
        leaseMs: DOCS_LIMITS.milestoneLeaseMs,
        // Джоб может умереть по аренде, минуя catch обработчика — тогда строка версии
        // навсегда осталась бы в pending и блокировала следующие вехи как «незакрытая».
        onDiscard: (payload) => this.failPending(String(payload.documentId)),
      },
    );
  }

  /**
   * Заказать веху В ТРАНЗАКЦИИ вызывающего. Если содержимое не менялось с прошлой
   * готовой вехи — не создаём ни строки, ни джоба: пустые версии засоряли бы историю
   * и съедали квоту копиями одних и тех же байт.
   */
  async requestMilestone(
    tx: Tx,
    opts: {
      documentId: string;
      reason: DocumentVersionReason;
      createdById?: string | null;
      authorIds?: string[];
    },
  ): Promise<void> {
    const doc = await tx.document.findUnique({
      where: { id: opts.documentId },
      select: { id: true, fileId: true, lastVersionNo: true },
    });
    if (!doc) return;
    const file = await tx.fileObject.findUnique({
      where: { id: doc.fileId },
      select: { sha256: true, status: true },
    });
    if (!file || file.status !== 'ready') return;

    const lastReady = await tx.documentVersion.findFirst({
      where: { documentId: doc.id, status: 'ready' },
      orderBy: { versionNo: 'desc' },
      select: { sha256: true },
    });
    if (file.sha256 && lastReady?.sha256 && file.sha256 === lastReady.sha256) return;

    // Номер берём АТОМАРНЫМ инкрементом и читаем обратно: «прочитал lastVersionNo и
    // записал +1» — гонка, а на (documentId, versionNo) стоит unique, и двойной клик по
    // «Сохранить версию» (или ручная веха ровно в момент закрытия сессии) отдавал бы
    // человеку 500 вместо версии. increment сериализуется блокировкой строки документа.
    const bumped = await tx.document.update({
      where: { id: doc.id },
      data: { lastVersionNo: { increment: 1 } },
      select: { lastVersionNo: true },
    });
    const versionNo = bumped.lastVersionNo;
    await tx.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo,
        reason: opts.reason,
        createdById: opts.createdById ?? null,
        authorIds: opts.authorIds ?? [],
      },
    });
    await this.jobs.enqueue(tx, {
      type: DOCS_JOB_TYPES.milestone,
      // payload — только id-шки (правило движка джобов)
      payload: { documentId: doc.id },
      // Контентно-адресуемый ключ: два закрытия сессии с одним и тем же содержимым
      // не поставят двух джобов. Обработчик всё равно разгребает ВСЕ pending-строки
      // документа, поэтому дедуп не может оставить строку без исполнителя.
      uniqueKey: `docs:ms:${doc.id}:${file.sha256 ?? versionNo}`,
    });
  }

  /** Ручная веха («Сохранить версию» / отпечаток перед подписанием) */
  async createManual(
    documentId: string,
    userId: string,
    reason: DocumentVersionReason,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const session = await tx.documentSession.findFirst({
        where: { documentId, status: 'open' },
        select: { participantIds: true },
      });
      await this.requestMilestone(tx, {
        documentId,
        reason,
        createdById: userId,
        authorIds: session?.participantIds ?? [userId],
      });
    });
  }

  async list(documentId: string): Promise<DocumentVersionDto[]> {
    const rows = await this.db.documentVersion.findMany({
      where: { documentId, status: { in: ['ready', 'pending'] } },
      orderBy: { versionNo: 'desc' },
      take: DOCS_LIMITS.versionsPageSize,
    });
    return rows.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      status: v.status as DocumentVersionDto['status'],
      reason: v.reason as DocumentVersionReason,
      // Без fileId версию нечем ни скачать, ни показать — список был бы витриной
      fileId: v.fileId,
      size: v.size === null ? null : Number(v.size),
      sha256: v.sha256,
      signed: v.signed,
      createdById: v.createdById,
      authorIds: v.authorIds,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  /**
   * Вернуть веху как текущее содержимое. Право проверяет вызывающий (как на правку).
   *
   * Порядок важен: СНАЧАЛА фиксируем то, что есть сейчас (если этого содержимого ещё нет
   * в истории), и только потом подменяем байты — иначе «вернуть» было бы действием без
   * отмены. Фиксируем СИНХРОННО, потому что снимок делается от ТЕКУЩИХ байт: отдай мы
   * это джобу, он бы проснулся уже после подмены и снял копию с возвращённой версии.
   */
  async restore(
    doc: { id: string; fileId: string },
    versionId: string,
    actorId: string,
  ): Promise<number> {
    const version = await this.db.documentVersion.findFirst({
      where: { id: versionId, documentId: doc.id, status: 'ready' },
      select: { id: true, versionNo: true, fileId: true },
    });
    if (!version?.fileId) throw new NotFoundException('Версия недоступна');

    await this.db.$transaction((tx) =>
      this.requestMilestone(tx, { documentId: doc.id, reason: 'manual', createdById: actorId }),
    );
    await this.materialize(doc.id); // тот же обработчик, что у джоба, — он идемпотентен

    const tmp = path.join(this.tmpDir(), `docs-restore-${randomUUID()}`);
    try {
      const { result } = await this.files.openRawStream(version.fileId, null);
      await pipeline(result.stream, fs.createWriteStream(tmp));
      // replaceContent ПОТРЕБЛЯЕТ исходник и сам его прибирает при любой ошибке
      await this.files.replaceContent({ fileId: doc.fileId, sourcePath: tmp, actorId });
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }
    await this.db.document.update({
      where: { id: doc.id },
      data: { lastSavedAt: new Date(), lastEditorId: actorId },
    });
    this.logger.log(`документ ${doc.id}: версия ${version.versionNo} возвращена как текущая`);
    return version.versionNo;
  }

  // ============================================================
  // Джоб: материализация снимка
  // ============================================================

  /**
   * Обработчик идемпотентен (исполнение at-least-once) и разгребает ВСЕ незакрытые
   * вехи документа, а не только «свою»: так дедуп по контенту не может оставить
   * строку без исполнителя, а повторный заход не плодит копий байт.
   */
  private async materialize(documentId: string): Promise<void> {
    const doc = await this.db.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new JobDiscardError(`документ ${documentId} удалён — веху резать нечем`);

    const pendings = await this.db.documentVersion.findMany({
      where: { documentId, status: 'pending' },
      orderBy: { versionNo: 'asc' },
    });
    if (!pendings.length) return; // уже материализовано прошлым заходом

    // Промежуточные вехи не догоняем: снимок делается от ТЕКУЩЕГО содержимого, и
    // старых байт для них уже не существует — честнее пометить пропущенными.
    const target = pendings[pendings.length - 1];
    const older = pendings.slice(0, -1);
    if (older.length) {
      await this.db.documentVersion.updateMany({
        where: { id: { in: older.map((v) => v.id) }, status: 'pending' },
        data: { status: 'skipped' },
      });
    }

    const file = await this.db.fileObject.findUnique({ where: { id: doc.fileId } });
    if (!file || file.status !== 'ready') {
      await this.db.documentVersion.updateMany({
        where: { id: target.id, status: 'pending' },
        data: { status: 'failed' },
      });
      throw new JobDiscardError(`файл документа ${documentId} недоступен`);
    }

    const lastReady = await this.db.documentVersion.findFirst({
      where: { documentId, status: 'ready' },
      orderBy: { versionNo: 'desc' },
      select: { sha256: true },
    });
    if (file.sha256 && lastReady?.sha256 && file.sha256 === lastReady.sha256) {
      await this.db.documentVersion.updateMany({
        where: { id: target.id, status: 'pending' },
        data: { status: 'skipped' },
      });
      return;
    }

    const tmp = path.join(this.tmpDir(), `docs-ms-${randomUUID()}`);
    try {
      const { result } = await this.files.openRawStream(doc.fileId, null);
      await pipeline(result.stream, fs.createWriteStream(tmp));

      const snapshot = await this.ingestSnapshot(target.id, {
        path: tmp,
        name: `${doc.title} (в${target.versionNo}).${doc.ext}`,
        // Канонический MIME формата: у документов, оживлённых до этой правки, в строке
        // может лежать application/octet-stream, который белый список профиля не примет.
        mime: documentFormatByExt(doc.ext)?.mime ?? doc.mime,
        // Профиль ИСХОДНИКА, а не жёсткий 'document': снимок — это копия уже принятого
        // файла, и мерить её более строгим профилем нечестно. 60-МБ презентация из чата
        // (профиль на 200 МБ) иначе не получила бы ни одной вехи: ingest падал бы на
        // потолке в 50 МБ, джоб выжигал бы 5 попыток и уходил в dead-letter.
        profile: file.profile,
        // Владелец снимка = владелец документа: квота вех организации ложится на
        // организацию, а не на того, кто случайно закрыл вкладку последним.
        ownerUserId: file.uploaderId,
        ownerType: doc.ownerType as FileOwnerType,
        ownerId: doc.ownerId,
      });

      // Связь ОБЯЗАТЕЛЬНА: ready-файл без единой привязки движок файлов считает
      // сиротой и прибирает свипом. Если транзакция ниже не пройдёт, снимок как раз
      // и уедет тем свипом — лишних байт в хранилище не останется.
      await this.db.$transaction(async (tx) => {
        await this.files.linkSystemInTx(tx, {
          fileId: snapshot.id,
          refType: 'document_version',
          refId: target.id,
          role: 'content',
          createdById: doc.createdById,
        });
        await tx.documentVersion.updateMany({
          where: { id: target.id, status: 'pending' },
          data: {
            status: 'ready',
            fileId: snapshot.id,
            sha256: snapshot.sha256,
            size: BigInt(snapshot.size),
          },
        });
      });
      this.logger.log(`веха ${target.versionNo} документа ${documentId} готова`);
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }

    await this.applyRetention(documentId);
  }

  /**
   * Инжест снимка с разделением ошибок на два класса (контракт core/jobs). Кончилась
   * квота, файл больше лимита профиля, тип не в белом списке — это ПОСТОЯННЫЕ отказы:
   * ретраить их бессмысленно, а 5 попыток по полминуты бэкоффа заканчиваются
   * dead-letter'ом и error-логом, то есть ложной аварией в проде. Помечаем веху failed
   * и хороним джоб сразу; сетевые/дисковые сбои по-прежнему уходят в обычный ретрай.
   */
  private async ingestSnapshot(
    versionId: string,
    opts: Parameters<FilesService['ingestLocalFile']>[0],
  ) {
    try {
      return await this.files.ingestLocalFile(opts);
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 0;
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (!permanent) throw err;
      await this.db.documentVersion.updateMany({
        where: { id: versionId, status: 'pending' },
        data: { status: 'failed' },
      });
      throw new JobDiscardError(
        `снимок вехи невозможен (${status}): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  /**
   * Ретеншн в хвосте того же джоба, что режет новую веху (иначе история молча съедала бы
   * квоту). Правило — БЮДЖЕТ МЕСТА, а не число копий: снимок это полная копия файла, и
   * «20 версий» у 200-МБ презентации означало бы 4 ГБ на один документ. Идём от самой
   * свежей версии и набираем, пока укладываемся в бюджет; при этом минимум оставляем
   * всегда (предыдущая версия должна быть у любого документа), а максимум не превышаем
   * даже у крошечного файла. Подписанные не удаляются никогда и слотов не занимают —
   * на них сошлётся ЭЦП.
   */
  private async applyRetention(documentId: string): Promise<void> {
    const ready = await this.db.documentVersion.findMany({
      where: { documentId, status: 'ready' },
      orderBy: { versionNo: 'desc' },
      select: { id: true, signed: true, size: true },
    });
    const doomed: Array<{ id: string }> = [];
    let kept = 0;
    let used = 0;
    for (const v of ready) {
      const size = Number(v.size ?? 0);
      if (v.signed) {
        used += size; // место занимает, но выселению не подлежит
        continue;
      }
      const mustKeep = kept < DOCS_LIMITS.minVersions;
      const fits = kept < DOCS_LIMITS.keepVersions && used + size <= DOCS_LIMITS.historyBudgetBytes;
      if (mustKeep || fits) {
        kept += 1;
        used += size;
        continue;
      }
      doomed.push(v);
    }
    for (const version of doomed) {
      // unlinkAllForRef снимает связь и прибирает осиротевший снимок (единая точка
      // уборки движка файлов — квота возвращается владельцу).
      await this.files.unlinkAllForRef('document_version', version.id).catch(() => undefined);
      await this.db.documentVersion.delete({ where: { id: version.id } }).catch(() => undefined);
    }
    if (doomed.length) {
      this.logger.log(`ретеншн документа ${documentId}: удалено вех ${doomed.length}`);
    }
  }

  /** Джоб похоронен — незакрытые вехи документа переводим в терминальный failed */
  private async failPending(documentId: string): Promise<void> {
    await this.db.documentVersion.updateMany({
      where: { documentId, status: 'pending' },
      data: { status: 'failed' },
    });
  }

  private tmpDir(): string {
    const root = path.resolve(process.cwd(), process.env.FILES_LOCAL_ROOT ?? './storage');
    const dir = path.join(root, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
