import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import {
  DOCS_JOB_TYPES,
  DOCS_LIMITS,
  DOCS_QUEUE,
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

    const versionNo = doc.lastVersionNo + 1;
    await tx.document.update({ where: { id: doc.id }, data: { lastVersionNo: versionNo } });
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
      size: v.size === null ? null : Number(v.size),
      sha256: v.sha256,
      signed: v.signed,
      createdById: v.createdById,
      authorIds: v.authorIds,
      createdAt: v.createdAt.toISOString(),
    }));
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

      const snapshot = await this.files.ingestLocalFile({
        path: tmp,
        name: `${doc.title} (в${target.versionNo}).${doc.ext}`,
        mime: doc.mime,
        profile: 'document',
        // Владелец снимка = владелец документа: квота вех организации ложится на
        // организацию, а не на того, кто случайно закрыл вкладку последним.
        ownerUserId: doc.createdById,
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
   * Ретеншн в хвосте того же джоба, что режет новую веху (иначе история молча съедала
   * бы квоту): держим последние N + ВСЕ подписанные — подписанную версию удалять
   * нельзя никогда, на неё будет ссылаться ЭЦП.
   */
  private async applyRetention(documentId: string): Promise<void> {
    const ready = await this.db.documentVersion.findMany({
      where: { documentId, status: 'ready' },
      orderBy: { versionNo: 'desc' },
      select: { id: true, signed: true },
    });
    const doomed = ready.slice(DOCS_LIMITS.keepVersions).filter((v) => !v.signed);
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
