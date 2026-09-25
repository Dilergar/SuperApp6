import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type LifecycleExport } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import * as yazl from 'yazl';
import {
  LIFECYCLE_BUS_EVENTS,
  LIFECYCLE_EXPORT_LIMITS,
  LIFECYCLE_EXPORT_PREFIX,
  LIFECYCLE_EXPORT_SCHEMA,
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_QUEUE,
  LIFECYCLE_WS_EVENTS,
  decodeCursor,
  encodeCursor,
  isLocale,
  lifecycleExportLinkMessage,
  lifecycleExportManifestPayload,
  type CursorPage,
  type LifecycleExportDto,
  type LifecycleExportError,
  type LifecycleExportLinkDto,
  type LifecycleExportManifest,
  type LifecycleExportManifestEntry,
  type LifecycleExportManifestFile,
  type LifecycleExportManifestSkip,
  type LifecycleExportMode,
  type LifecycleExportPart,
  type LifecycleExportPhase,
  type LifecycleExportStatus,
  type LifecycleExportSubjectType,
  type LifecycleExportUpdatedBusPayload,
  type LifecycleExportsQuery,
  type Locale,
  type RichCardPayload,
  type WsLifecycleExportUpdated,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { conflict, forbidden, notFound, tooMany } from '../../shared/errors/api-error';
import { EventBusService } from '../../shared/events/event-bus.service';
import { appTmpPath } from '../../shared/fs/temp-file.util';
import { I18nService } from '../../shared/i18n/i18n.service';
import { RedisService } from '../../shared/redis/redis.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { ChatterService } from '../chatter/chatter.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { STORAGE_DRIVER, type StorageDriver, type StorageStreamResult } from '../files/storage/storage-driver';
import { JobDiscardError, JobSnoozeError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { KeysSigningService } from '../keys/keys.signing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { RealtimeRegistry } from '../realtime/realtime.registry';
import { RichCardRegistry } from '../rich-cards/rich-cards.registry';
import { StepUpService } from '../verify/step-up.service';
import { LifecycleExportCollector, LifecycleExportOwnerMismatch, exportSafeValue, type LifecycleCollectedPage, type LifecycleExportFileRef } from './lifecycle.export.collector';
import type { LifecycleExportContext } from './lifecycle.export.registry';
import { LifecycleErasureService, exportObjectKeys } from './lifecycle.erasure.service';
import { LifecyclePurgeHandlerRegistry } from './lifecycle.purge.registry';
import { LIFECYCLE_SETTINGS_REF_TYPE } from './lifecycle.settings.service';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
/** Сборка без движения дольше этого — потерянный джоб: заявка падает с `internal`. */
const STALE_BUILD_MS = 2 * DAY;
/** Аренда захода сборки: часть ZIP до 2 ГБ — с запасом (= аренда джоба). */
const BUILD_LEASE_MS = 45 * 60_000;
/** Сжатые форматы байтов пакуются без повторного сжатия (CPU впустую). */
const STORED_MIME = /^(image|video|audio)\/|^application\/(zip|gzip|x-7z|x-rar|pdf|vnd\.openxmlformats)/;

/** Источник строк сборки: переносимый сборщик или извлечение восстановления. */
export interface LifecycleExportSource {
  plan(side: 'user' | 'workspace'): string[];
  skipReason(ctx: LifecycleExportContext, policyId: string): Promise<'entitlement' | null>;
  page(ctx: LifecycleExportContext, policyId: string, cursor: string | null, limit: number, opts: { injectForeign?: boolean }): Promise<LifecycleCollectedPage>;
}

interface StagedChunk {
  key: string;
  policyId: string;
  n: number;
  rows: number;
  bytes: number;
  sha256: string;
  kind: 'data' | 'files';
}
interface PartPlan {
  data: number[];
  files: Array<{ chunk: number; from: number; to: number }>;
  bytes: number;
}
interface ExportProgress {
  phase: LifecycleExportPhase;
  plan: string[];
  policy: number;
  cursor: string | null;
  n: number;
  staged: StagedChunk[];
  skipped: LifecycleExportManifestSkip[];
  guarded: Record<string, string[]>;
  rows: number;
  parts?: PartPlan[];
  built?: LifecycleExportPart[];
  /** Ключи staging-кусков с манифестом файлов уже упакованных частей */
  fileManifests?: string[];
}
interface ExportOptions {
  locale?: Locale;
  injectForeign?: boolean;
}

/** Кусок JSONL на временном диске: строки, байты и sha256 считаются по ходу записи. */
class ChunkWriter {
  rows = 0;
  bytes = 0;
  private readonly hash = createHash('sha256');
  private readonly out;

  constructor(readonly path: string) {
    this.out = createWriteStream(path);
  }

  async write(line: string): Promise<void> {
    const buf = Buffer.from(line + '\n', 'utf8');
    this.hash.update(buf);
    this.rows += 1;
    this.bytes += buf.length;
    if (!this.out.write(buf)) await new Promise<void>((r) => this.out.once('drain', () => r()));
  }

  async close(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.out.once('error', reject);
      this.out.end(() => resolve());
    });
    return this.hash.digest('hex');
  }
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** Имя файла в ZIP без разделителей пути и управляющих символов (архив открывают в любой ОС). */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120);
  return cleaned || 'file';
}

/** Поток, считающий sha256 и байты того, что сквозь него прошло. */
function hashingStream(src: Readable): { stream: PassThrough; done: Promise<{ sha256: string; bytes: number }> } {
  const hash = createHash('sha256');
  let bytes = 0;
  const out = new PassThrough();
  const done = new Promise<{ sha256: string; bytes: number }>((resolve, reject) => {
    src.on('data', (c: Buffer) => {
      hash.update(c);
      bytes += c.length;
    });
    src.on('error', (err) => {
      out.destroy(err);
      reject(err);
    });
    out.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
  src.pipe(out);
  return { stream: out, done };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function asProgress(v: unknown): ExportProgress | null {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as ExportProgress).phase === 'string' ? (v as ExportProgress) : null;
}

function partsOf(v: unknown): LifecycleExportPart[] {
  return Array.isArray(v) ? (v as LifecycleExportPart[]).filter((p) => p && typeof p.key === 'string') : [];
}

/**
 * Выгрузки данных (core/lifecycle Э6) — переносимость (ЗоПД ст. 24, GDPR ст. 20, Google Takeout):
 * человек забирает свои данные целиком, владелец — данные организации.
 *
 * Заказ — под окном SMS-подтверждения `data_export` (угнанная сессия без SIM архив не унесёт),
 * не чаще раза в сутки на субъекта (замок субъекта в транзакции заявки), у организации —
 * только владелец, фича тарифа `lifecycle.export` и суточная квота байтов.
 *
 * Сборка — джоб `lifecycle.export` фазами с бюджетом захода (снуз продолжает с сохранённого
 * места): `collect` — политики реестра стороны кусками JSONL во временный префикс выгрузки;
 * `package` — части ZIP ≤ 2 ГБ, байты файлов с перепроверкой владельца по свежей строке;
 * `finish` — манифест (в последней части), готово на 7 дней, уведомление. Чужая строка в любой
 * фазе — сборка падает целиком (`owner_mismatch`).
 *
 * Скачивание — только через страницу: каждое нажатие = своя ссылка на 5 минут (presign — токен
 * на предъявителя), не больше 5 выдач на часть, каждая выдача — `data.export` в журнал.
 */
@Injectable()
export class LifecycleExportService implements OnModuleInit {
  private readonly logger = new Logger(LifecycleExportService.name);
  private restoreSource: LifecycleExportSource | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly collector: LifecycleExportCollector,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    private readonly signing: KeysSigningService,
    private readonly stepUp: StepUpService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationsService,
    private readonly notificationRefs: NotificationRefRegistry,
    private readonly events: EventBusService,
    private readonly realtime: RealtimeRegistry,
    private readonly richCards: RichCardRegistry,
    private readonly chatter: ChatterService,
    private readonly i18n: I18nService,
    private readonly erasure: LifecycleErasureService,
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly redis: RedisService,
  ) {}

  /** Извлечение восстановления арендатора подключает себя источником сборки (Кабинет). */
  setRestoreSource(source: LifecycleExportSource): void {
    this.restoreSource = source;
  }

  onModuleInit(): void {
    this.jobsRegistry.register(LIFECYCLE_JOBS.export, (payload) => this.handle(String((payload as Record<string, unknown>).exportId ?? '')), {
      queue: LIFECYCLE_QUEUE,
      queueConcurrency: 2,
      // Часть ZIP (до 2 ГБ) пакуется одним заходом — аренда с запасом на поток байтов
      leaseMs: BUILD_LEASE_MS,
      maxAttempts: 25,
      onDiscard: async (payload, info) => {
        const id = String((payload as Record<string, unknown>).exportId ?? '');
        if (id) await this.fail(id, 'internal', info.error);
      },
    });

    // Срок: байты готового архива — по `expiresAt` (derived), строка заявки — через месяц
    this.handlers.register('lifecycle.exports', {
      purgeBatch: (ctx) => (ctx.policy.store.kind === 'derived' ? this.expireBatch(ctx.limit, ctx.releasable) : this.pruneBatch(ctx.limit, ctx.releasable)),
      estimate: async (ctx) =>
        ctx.policy.store.kind === 'derived'
          ? this.db.lifecycleExport.count({ where: { status: 'ready', expiresAt: { lt: new Date() } } })
          : this.db.lifecycleExport.count({ where: { createdAt: { lt: new Date(Date.now() - LIFECYCLE_EXPORT_LIMITS.rowDays * DAY) } } }),
    });

    // Уведомление о готовности видит только заказчик; ведёт на страницу выгрузок
    this.notificationRefs.register('lifecycle_export', {
      canViewMany: async (userIds, exportId) => {
        const row = await this.db.lifecycleExport.findUnique({ where: { id: exportId }, select: { requestedById: true, mode: true } });
        return row && row.mode === 'portable' ? userIds.filter((id) => id === row.requestedById) : [];
      },
      href: (ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/profile/data/exports` : '/profile/my-data#exports'),
    });

    // Сокет: статус выгрузки сменился — страница перечитывает список
    this.realtime.registerRelay(LIFECYCLE_BUS_EVENTS.exportUpdated, ({ payload }) => {
      const p = payload as LifecycleExportUpdatedBusPayload;
      if (!p?.userIds?.length) return null;
      const msg: WsLifecycleExportUpdated = { exportId: p.exportId, subjectType: p.subjectType, subjectId: p.subjectId, status: p.status };
      return { rooms: p.userIds.map((id) => `user:${id}`), name: LIFECYCLE_WS_EVENTS.exportUpdated, payload: msg };
    });

    // Рич-карта «Архив данных»: статус, срок, скачивания; кнопок нет — скачивание только со страницы
    this.richCards.registerRenderer('lifecycle_export', (_deps, viewerId, refId) => this.renderCard(viewerId, refId));
  }

  // ============================================================
  // Заказ
  // ============================================================

  private locale(): Locale {
    const l = this.i18n.locale;
    return isLocale(l) ? l : 'en';
  }

  /** Человек заказывает архив своих данных (право субъекта — от тарифа не зависит). */
  async requestForUser(userId: string): Promise<LifecycleExportDto> {
    await this.stepUp.assert(userId, 'data_export');
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { deletedAt: true, kind: true } });
    if (!user || user.deletedAt || user.kind === 'bot') throw notFound('auth.userNotFound');
    const locale = this.locale();
    const row = await this.db.$transaction(async (tx) => {
      await this.lockSubject(tx, 'user', userId);
      await this.assertCooldown(tx, 'user', userId);
      const created = await tx.lifecycleExport.create({
        data: { subjectType: 'user', subjectId: userId, requestedById: userId, mode: 'portable', options: { locale } as Prisma.InputJsonValue },
      });
      await this.jobs.enqueue(tx, { type: LIFECYCLE_JOBS.export, payload: { exportId: created.id }, uniqueKey: `export:${created.id}` });
      await this.analytics.track(tx, 'lifecycle.export.requested', { subjectType: 'user' }, { userId, workspaceId: null });
      return created;
    });
    return this.toDto(row, userId);
  }

  /**
   * Владелец заказывает архив организации (Slack Primary Owner): фича тарифа, суточная квота
   * байтов (предпроверка; списание — фактом сборки), не чаще раза в сутки.
   */
  async requestForWorkspace(userId: string, workspaceId: string): Promise<LifecycleExportDto> {
    await this.assertOwner(userId, workspaceId);
    await this.stepUp.assert(userId, 'data_export');
    await this.entitlements.assertFeature(userId, 'lifecycle.export', { type: 'workspace', id: workspaceId });
    await this.entitlements.assertQuotaHeadroom({ type: 'workspace', id: workspaceId }, 'lifecycle.export.bytesPerDay', 1);
    const locale = this.locale();
    const row = await this.db.$transaction(async (tx) => {
      await this.lockSubject(tx, 'workspace', workspaceId);
      await this.assertCooldown(tx, 'workspace', workspaceId);
      const created = await tx.lifecycleExport.create({
        data: { subjectType: 'workspace', subjectId: workspaceId, requestedById: userId, mode: 'portable', options: { locale } as Prisma.InputJsonValue },
      });
      await this.jobs.enqueue(tx, { type: LIFECYCLE_JOBS.export, payload: { exportId: created.id }, uniqueKey: `export:${created.id}` });
      await this.chatter.log(tx, {
        refType: LIFECYCLE_SETTINGS_REF_TYPE,
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        typeKey: 'lifecycle_settings.export_requested',
        payload: {},
      });
      await this.analytics.track(tx, 'lifecycle.export.requested', { subjectType: 'workspace' }, { userId, workspaceId });
      return created;
    });
    return this.toDto(row, userId);
  }

  /**
   * Архив восстановления арендатора (Кабинет, команда `lifecycle.restore.extract`) — В
   * транзакции команды: заявка и джоб коммитятся вместе с журналом команды.
   */
  async requestRestoreArchive(tx: Tx, actorId: string, workspaceId: string, snapshotAt: Date): Promise<string> {
    const created = await tx.lifecycleExport.create({
      data: { subjectType: 'workspace', subjectId: workspaceId, requestedById: actorId, mode: 'restore', snapshotAt },
      select: { id: true },
    });
    await this.jobs.enqueue(tx, { type: LIFECYCLE_JOBS.export, payload: { exportId: created.id }, uniqueKey: `export:${created.id}` });
    return created.id;
  }

  /**
   * Дев-полигон: заявка без окна SMS и суточного окна, с подсадкой чужой строки (страж владельца
   * обязан её поймать). Организацию — только её владелец (как в продукте).
   */
  async requestDev(userId: string, opts: { injectForeign?: boolean; workspaceId?: string }): Promise<LifecycleExportDto> {
    if (opts.workspaceId) await this.assertOwner(userId, opts.workspaceId);
    const subjectType: LifecycleExportSubjectType = opts.workspaceId ? 'workspace' : 'user';
    const subjectId = opts.workspaceId ?? userId;
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.lifecycleExport.create({
        data: {
          subjectType,
          subjectId,
          requestedById: userId,
          mode: 'portable',
          options: { locale: this.locale(), injectForeign: !!opts.injectForeign } as Prisma.InputJsonValue,
        },
      });
      await this.jobs.enqueue(tx, { type: LIFECYCLE_JOBS.export, payload: { exportId: created.id }, uniqueKey: `export:${created.id}` });
      return created;
    });
    return this.toDto(row, userId);
  }

  private async lockSubject(tx: Tx, type: LifecycleExportSubjectType, id: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lifecycle.export:${type}:${id}`}))`;
  }

  /** Не чаще раза в сутки на субъекта: упавшая сборка окно не занимает. */
  private async assertCooldown(tx: Tx, type: LifecycleExportSubjectType, id: string): Promise<void> {
    const since = new Date(Date.now() - LIFECYCLE_EXPORT_LIMITS.cooldownHours * 3600_000);
    const last = await tx.lifecycleExport.findFirst({
      where: { subjectType: type, subjectId: id, mode: 'portable', status: { not: 'failed' }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last) {
      const retryAt = new Date(last.createdAt.getTime() + LIFECYCLE_EXPORT_LIMITS.cooldownHours * 3600_000);
      throw tooMany('lifecycle.exportTooSoon', undefined, { resendInSec: Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000)), retryAt: retryAt.toISOString() });
    }
  }

  /** Организацию выгружает только владелец живой организации; чужому — 404 (не оракул). */
  private async assertOwner(userId: string, workspaceId: string): Promise<void> {
    const role = await this.db.userRole.findFirst({ where: { userId, context: 'workspace', tenantId: workspaceId, isActive: true, role: 'owner' }, select: { id: true } });
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { isActive: true } });
    if (!ws) throw notFound('workspace.notFound');
    if (!role) {
      const member = await this.db.userRole.findFirst({ where: { userId, context: 'workspace', tenantId: workspaceId, isActive: true }, select: { id: true } });
      if (!member) throw notFound('workspace.notFound');
      throw forbidden('lifecycle.exportOwnerOnly');
    }
    if (!ws.isActive) throw forbidden('workspace.inactive');
  }

  /** Видит выгрузки организации владелец и админ (качает — заказчик). */
  private async assertManager(userId: string, workspaceId: string): Promise<void> {
    const role = await this.db.userRole.findFirst({
      where: { userId, context: 'workspace', tenantId: workspaceId, isActive: true, role: { in: ['owner', 'admin'] } },
      select: { id: true },
    });
    if (!role) throw notFound('workspace.notFound');
  }

  // ============================================================
  // Чтение
  // ============================================================

  async listForUser(userId: string, q: LifecycleExportsQuery): Promise<CursorPage<LifecycleExportDto>> {
    return this.page({ subjectType: 'user', subjectId: userId, mode: 'portable' }, q, userId);
  }

  async listForWorkspace(userId: string, workspaceId: string, q: LifecycleExportsQuery): Promise<CursorPage<LifecycleExportDto>> {
    await this.assertManager(userId, workspaceId);
    return this.page({ subjectType: 'workspace', subjectId: workspaceId, mode: 'portable' }, q, userId);
  }

  private async page(where: Prisma.LifecycleExportWhereInput, q: LifecycleExportsQuery, viewerId: string): Promise<CursorPage<LifecycleExportDto>> {
    const limit = q.limit ?? 20;
    const cur = q.cursor ? decodeCursor(q.cursor, { createdAt: 'date', id: 'uuid' }) : null;
    const rows = await this.db.lifecycleExport.findMany({
      where: {
        ...where,
        ...(cur ? { OR: [{ createdAt: { lt: cur.createdAt } }, { createdAt: cur.createdAt, id: { lt: cur.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => this.toDto(r, viewerId)),
      nextCursor: more && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  toDto(r: LifecycleExport, viewerId: string): LifecycleExportDto {
    const progress = asProgress(r.progress);
    const parts = partsOf(r.parts);
    const live = r.status === 'queued' || r.status === 'running';
    return {
      id: r.id,
      subjectType: r.subjectType as LifecycleExportSubjectType,
      subjectId: r.subjectId,
      mode: r.mode as LifecycleExportMode,
      status: r.status as LifecycleExportStatus,
      progress: live
        ? progress
          ? progress.phase === 'collect'
            ? { phase: 'collect', done: progress.policy, total: progress.plan.length }
            : { phase: progress.phase, done: progress.built?.length ?? 0, total: progress.parts?.length ?? 0 }
          : { phase: 'collect', done: 0, total: 0 }
        : null,
      rows: r.rows,
      bytes: Number(r.bytes),
      parts: r.status === 'ready' ? parts.map((p, i) => ({ index: i + 1, bytes: p.bytes, downloads: p.downloads ?? 0, maxDownloads: LIFECYCLE_EXPORT_LIMITS.maxDownloadsPerPart })) : [],
      errorCode: (r.errorCode as LifecycleExportError | null) ?? null,
      requestedById: r.requestedById,
      canDownload: r.requestedById === viewerId && r.mode === 'portable',
      createdAt: r.createdAt.toISOString(),
      readyAt: r.readyAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    };
  }

  // ============================================================
  // Скачивание
  // ============================================================

  /**
   * Ссылка на часть готового архива: только заказчику, под окном SMS-подтверждения, не больше
   * `maxDownloadsPerPart` выдач на часть (счёт — атомарно в той же строке), живёт 5 минут.
   * Каждая выдача — `data.export` в журнал безопасности (человек видит её в своей ленте,
   * организация — в своём журнале).
   */
  async link(userId: string, exportId: string, part: number): Promise<LifecycleExportLinkDto> {
    const row = await this.db.lifecycleExport.findUnique({ where: { id: exportId } });
    if (!row || row.requestedById !== userId || row.mode !== 'portable') throw notFound('lifecycle.exportNotFound');
    await this.stepUp.assert(userId, 'data_export');
    if (row.status === 'expired' || (row.status === 'ready' && row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw conflict('lifecycle.exportExpired');
    if (row.status !== 'ready') throw conflict('lifecycle.exportNotReady');
    const parts = partsOf(row.parts);
    const p = parts[part - 1];
    if (!p) throw notFound('lifecycle.exportNotFound');
    const max = LIFECYCLE_EXPORT_LIMITS.maxDownloadsPerPart;
    const idx = part - 1;
    const download = await this.db.$transaction(async (tx) => {
      const [hit] = await tx.$queryRaw<Array<{ n: number }>>`
        UPDATE "lifecycle_exports"
           SET parts = jsonb_set(parts, ARRAY[${String(idx)}, 'downloads'], to_jsonb(COALESCE((parts -> ${idx}::int ->> 'downloads')::int, 0) + 1)),
               downloads = downloads + 1
         WHERE id = ${exportId}::uuid AND status = 'ready' AND expires_at > now()
           AND COALESCE((parts -> ${idx}::int ->> 'downloads')::int, 0) < ${max}
        RETURNING (parts -> ${idx}::int ->> 'downloads')::int AS n`;
      if (!hit) return null;
      await this.audit.record(tx, {
        key: 'data.export',
        ...(row.subjectType === 'user' ? { subjectUserId: userId } : { workspaceId: row.subjectId }),
        target: { type: 'lifecycle_export', id: exportId },
        details: { source: 'lifecycle', rows: row.rows ?? 0, format: 'zip' },
      });
      await this.analytics.track(tx, 'lifecycle.export.downloaded', { subjectType: row.subjectType, download: Number(hit.n) }, { userId, workspaceId: row.subjectType === 'workspace' ? row.subjectId : null });
      return Number(hit.n);
    });
    if (download === null) {
      const fresh = await this.db.lifecycleExport.findUnique({ where: { id: exportId }, select: { status: true, expiresAt: true } });
      if (!fresh || fresh.status !== 'ready' || (fresh.expiresAt && fresh.expiresAt.getTime() <= Date.now())) throw conflict('lifecycle.exportExpired');
      throw conflict('lifecycle.exportDownloadsExhausted', { max });
    }
    const ttl = LIFECYCLE_EXPORT_LIMITS.linkTtlSec;
    const fileName = `superapp6-${row.subjectType === 'user' ? 'my-data' : 'organization-data'}-${(row.readyAt ?? row.createdAt).toISOString().slice(0, 10)}-part-${pad3(part)}.zip`;
    const presigned = await this.storage.presignedGet(p.key, ttl, { disposition: `attachment; filename="${fileName}"`, mime: 'application/zip' });
    const exp = Math.floor(Date.now() / 1000) + ttl;
    let url = presigned;
    if (!url) {
      const { kid, sig } = await this.signing.signRaw('lifecycle', lifecycleExportLinkMessage(exportId, part, exp));
      const base = (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/+$/, '');
      const qs = new URLSearchParams({ exp: String(exp), k: kid, sig });
      url = `${base}/api/v1/lifecycle/exports/${exportId}/parts/${part}/raw?${qs.toString()}`;
    }
    return { url, expiresAt: new Date(exp * 1000).toISOString(), downloadsLeft: Math.max(0, max - download) };
  }

  /**
   * Байты части по подписанной ссылке (local-драйвер): подпись и срок в query, архив ещё
   * готов. Ссылка без входа (браузер скачивает её сам) — ключ к ней выдан под SMS-окном.
   */
  async rawPart(exportId: string, part: number, exp: number, kid: string, sig: string, range?: { start: number; end?: number }): Promise<{ result: StorageStreamResult; fileName: string }> {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) throw notFound('lifecycle.exportNotFound');
    const ok = await this.signing.verifyRaw('lifecycle', kid, lifecycleExportLinkMessage(exportId, part, exp), sig).catch(() => false);
    if (!ok) throw notFound('lifecycle.exportNotFound');
    const row = await this.db.lifecycleExport.findUnique({ where: { id: exportId }, select: { status: true, expiresAt: true, parts: true, subjectType: true, readyAt: true, createdAt: true } });
    if (!row || row.status !== 'ready' || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) throw notFound('lifecycle.exportNotFound');
    const p = partsOf(row.parts)[part - 1];
    if (!p) throw notFound('lifecycle.exportNotFound');
    const result = await this.storage.getStream(p.key, range);
    const fileName = `superapp6-${row.subjectType === 'user' ? 'my-data' : 'organization-data'}-${(row.readyAt ?? row.createdAt).toISOString().slice(0, 10)}-part-${pad3(part)}.zip`;
    return { result, fileName };
  }

  // ============================================================
  // Сборка (джоб)
  // ============================================================

  /**
   * Заход сборки под замком выгрузки: протухшая аренда джоба (JS не убить) и новый воркер не
   * должны собирать одну выгрузку вдвоём — второй заход ждёт.
   */
  private async handle(exportId: string): Promise<void> {
    if (!exportId) throw new JobDiscardError('export id is empty');
    const ran = await this.redis.withLock(`lifecycle:export-lease:${exportId}`, BUILD_LEASE_MS, async () => {
      await this.pass(exportId);
      return true;
    });
    if (ran === null) throw new JobSnoozeError(30_000, 'another pass of this export is running');
  }

  /** Дев-полигон: довести сборку сейчас (заходы подряд вместо снузов джоба). */
  async runNow(exportId: string, viewerId: string): Promise<LifecycleExportDto | null> {
    for (let i = 0; i < 500; i += 1) {
      try {
        await this.handle(exportId);
      } catch (err) {
        if (!(err instanceof JobSnoozeError)) throw err;
      }
      const r = await this.db.lifecycleExport.findUnique({ where: { id: exportId }, select: { status: true } });
      if (!r || (r.status !== 'queued' && r.status !== 'running')) break;
    }
    const row = await this.db.lifecycleExport.findUnique({ where: { id: exportId } });
    return row ? this.toDto(row, viewerId) : null;
  }

  private async pass(exportId: string): Promise<void> {
    const [row] = await this.db.$queryRaw<LifecycleExport[]>`
      UPDATE "lifecycle_exports" SET status = 'running', attempts = attempts + 1
       WHERE id = ${exportId}::uuid AND status IN ('queued', 'running')
      RETURNING *`;
    if (!row) return; // готова, упала или истекла — делать нечего
    const r = await this.db.lifecycleExport.findUnique({ where: { id: exportId } });
    if (!r) return;
    const deadline = Date.now() + LIFECYCLE_EXPORT_LIMITS.budgetMs;
    const source = r.mode === 'restore' ? this.restoreSource : this.collector;
    if (!source) throw new Error('restore source is not registered');
    try {
      if (r.mode === 'portable' && !(await this.subjectAlive(r))) {
        await this.fail(r.id, 'subject_gone');
        return;
      }
      const progress = asProgress(r.progress) ?? this.initProgress(r, source);
      if (progress.phase === 'collect') {
        const done = await this.collect(r, progress, source, deadline);
        if (!done) throw new JobSnoozeError(LIFECYCLE_LIMITS.continueDelayMs, 'budget spent, continuing');
        progress.phase = r.mode === 'restore' ? 'finish' : 'package';
        await this.save(r.id, progress);
      }
      if (progress.phase === 'package') {
        const more = await this.packagePart(r, progress);
        if (more === 'failed') return;
        if (more) throw new JobSnoozeError(LIFECYCLE_LIMITS.continueDelayMs, 'next part');
        progress.phase = 'finish';
        await this.save(r.id, progress);
      }
      if (progress.phase === 'finish') await this.finish(r, progress);
    } catch (err) {
      if (err instanceof JobSnoozeError) throw err;
      if (err instanceof LifecycleExportOwnerMismatch) {
        await this.fail(r.id, 'owner_mismatch', err.message);
        return;
      }
      throw err;
    }
  }

  private initProgress(r: LifecycleExport, source: LifecycleExportSource): ExportProgress {
    return { phase: 'collect', plan: source.plan(r.subjectType as 'user' | 'workspace'), policy: 0, cursor: null, n: 0, staged: [], skipped: [], guarded: {}, rows: 0 };
  }

  private async save(id: string, progress: ExportProgress, extra: Prisma.LifecycleExportUpdateInput = {}): Promise<void> {
    await this.db.lifecycleExport.update({ where: { id }, data: { progress: progress as unknown as Prisma.InputJsonValue, ...extra } });
  }

  private ctxOf(r: LifecycleExport): LifecycleExportContext {
    const opts = (r.options ?? {}) as ExportOptions;
    return {
      exportId: r.id,
      side: r.subjectType as 'user' | 'workspace',
      subjectId: r.subjectId,
      requesterId: r.requestedById,
      locale: opts.locale && isLocale(opts.locale) ? opts.locale : 'en',
    };
  }

  /** Субъект жив: аккаунт не удалён, организация активна (переносимый архив — живым). */
  private async subjectAlive(r: LifecycleExport): Promise<boolean> {
    if (r.subjectType === 'user') {
      const u = await this.db.user.findUnique({ where: { id: r.subjectId }, select: { deletedAt: true } });
      return !!u && !u.deletedAt;
    }
    const ws = await this.db.workspace.findUnique({ where: { id: r.subjectId }, select: { isActive: true } });
    return !!ws?.isActive;
  }

  private prefix(id: string): string {
    return `${LIFECYCLE_EXPORT_PREFIX}${id}/`;
  }

  /**
   * Фаза сбора: политики плана по порядку, куски ≤ `chunkRows` строк. Каждый кусок пишется
   * целиком за заход (временный файл → объект хранилища), прогресс сохраняется после каждого —
   * обрыв повторит только незаписанный кусок (тот же ключ перезапишется).
   */
  private async collect(r: LifecycleExport, progress: ExportProgress, source: LifecycleExportSource, deadline: number): Promise<boolean> {
    const ctx = this.ctxOf(r);
    const opts = (r.options ?? {}) as ExportOptions;
    const restore = r.mode === 'restore';
    while (progress.policy < progress.plan.length) {
      if (Date.now() > deadline) return false;
      const policyId = progress.plan[progress.policy]!;
      if (progress.cursor === null && progress.n === 0) {
        const skip = await source.skipReason(ctx, policyId);
        if (skip) {
          progress.skipped.push({ policyId, reason: skip });
          progress.policy += 1;
          await this.save(r.id, progress);
          continue;
        }
      }
      const tag = `${r.id}-${policyId}-${progress.n}`;
      const data = new ChunkWriter(appTmpPath(`export-${tag}.jsonl`));
      const files = new ChunkWriter(appTmpPath(`export-${tag}.files.jsonl`));
      let cursor = progress.cursor;
      let done = false;
      try {
        while (data.rows < LIFECYCLE_EXPORT_LIMITS.chunkRows) {
          const page = await source.page(ctx, policyId, cursor, LIFECYCLE_EXPORT_LIMITS.batchRows, { injectForeign: !!opts.injectForeign && !restore });
          // Одна дверь: и строки провайдеров модулей проходят очистку слов-секретов (fail-closed)
          for (const row of page.rows) await data.write(JSON.stringify(restore ? row : exportSafeValue(row)));
          for (const line of page.lines ?? []) await data.write(line);
          for (const f of page.files) await files.write(JSON.stringify(f));
          if (page.guarded.length) progress.guarded[policyId] = [...new Set([...(progress.guarded[policyId] ?? []), ...page.guarded])];
          cursor = page.next;
          if (!cursor) {
            done = true;
            break;
          }
          if (Date.now() > deadline) break;
        }
        const dataSha = await data.close();
        const filesSha = await files.close();
        if (data.rows) {
          const key = restore ? `${this.prefix(r.id)}data/${policyId}.${pad3(progress.n + 1)}.jsonl` : `${this.prefix(r.id)}staging/${policyId}.${pad3(progress.n + 1)}.jsonl`;
          await this.storage.putFromFile(key, data.path, 'application/x-ndjson');
          progress.staged = progress.staged.filter((s) => s.key !== key);
          progress.staged.push({ key, policyId, n: progress.n + 1, rows: data.rows, bytes: data.bytes, sha256: dataSha, kind: 'data' });
          progress.rows += data.rows;
        }
        if (files.rows) {
          const key = `${this.prefix(r.id)}staging/files.${policyId}.${pad3(progress.n + 1)}.jsonl`;
          await this.storage.putFromFile(key, files.path, 'application/x-ndjson');
          progress.staged = progress.staged.filter((s) => s.key !== key);
          progress.staged.push({ key, policyId, n: progress.n + 1, rows: files.rows, bytes: files.bytes, sha256: filesSha, kind: 'files' });
        }
      } finally {
        await fs.unlink(data.path).catch(() => undefined);
        await fs.unlink(files.path).catch(() => undefined);
      }
      if (done) {
        progress.policy += 1;
        progress.cursor = null;
        progress.n = 0;
      } else {
        progress.cursor = cursor;
        progress.n += 1;
      }
      await this.save(r.id, progress);
    }
    return true;
  }

  private async readJsonl<T>(key: string): Promise<T[]> {
    const { stream } = await this.storage.getStream(key);
    const out: T[] = [];
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) out.push(JSON.parse(line) as T);
    return out;
  }

  /** План частей: куски данных и файлы по порядку, часть ≤ `partMaxBytes` (крупный файл — своей частью). */
  private async planParts(progress: ExportProgress): Promise<{ parts: PartPlan[]; total: number }> {
    const max = LIFECYCLE_EXPORT_LIMITS.partMaxBytes;
    const parts: PartPlan[] = [];
    let cur: PartPlan = { data: [], files: [], bytes: 0 };
    let total = 0;
    const flush = () => {
      if (cur.data.length || cur.files.length) parts.push(cur);
      cur = { data: [], files: [], bytes: 0 };
    };
    progress.staged.forEach((s, i) => {
      if (s.kind !== 'data') return;
      if (cur.bytes > 0 && cur.bytes + s.bytes > max) flush();
      cur.data.push(i);
      cur.bytes += s.bytes;
      total += s.bytes;
    });
    for (let i = 0; i < progress.staged.length; i += 1) {
      const s = progress.staged[i]!;
      if (s.kind !== 'files') continue;
      const refs = await this.readJsonl<LifecycleExportFileRef>(s.key);
      let from = 0;
      for (let j = 0; j < refs.length; j += 1) {
        const b = refs[j]!.bytes;
        if (cur.bytes > 0 && cur.bytes + b > max) {
          if (j > from) cur.files.push({ chunk: i, from, to: j - 1 });
          flush();
          from = j;
        }
        cur.bytes += b;
        total += b;
      }
      if (refs.length > from) cur.files.push({ chunk: i, from, to: refs.length - 1 });
    }
    flush();
    // Пустой архив — всё равно одна часть: манифест и README
    if (!parts.length) parts.push({ data: [], files: [], bytes: 0 });
    return { parts, total };
  }

  /**
   * Упаковка ОДНОЙ части за заход: куски данных и байты файлов (перепроверка владельца по
   * свежей строке файла — удалённый пропускается, чужой роняет сборку) → ZIP во временный
   * файл → объект хранилища. Последняя часть несёт манифест и README. `true` — есть ещё части.
   */
  private async packagePart(r: LifecycleExport, progress: ExportProgress): Promise<boolean | 'failed'> {
    if (!progress.parts) {
      const { parts, total } = await this.planParts(progress);
      if (total > LIFECYCLE_EXPORT_LIMITS.maxTotalBytes) {
        await this.fail(r.id, 'too_large');
        return 'failed';
      }
      if (r.subjectType === 'workspace') {
        const q = await this.entitlements.quotaState({ type: 'workspace', id: r.subjectId }, 'lifecycle.export.bytesPerDay');
        if (q.limit !== null && q.used + total > q.limit) {
          await this.fail(r.id, 'quota');
          return 'failed';
        }
      }
      progress.parts = parts;
      progress.built = [];
      progress.fileManifests = [];
      await this.save(r.id, progress);
    }
    const built = progress.built ?? [];
    const k = built.length;
    const part = progress.parts[k];
    if (!part) return false;
    const last = k === progress.parts.length - 1;
    const ctx = this.ctxOf(r);
    const tmp = appTmpPath(`export-${r.id}-part-${k + 1}.zip`);
    const fileEntries: LifecycleExportManifestFile[] = [];
    try {
      const zip = new yazl.ZipFile();
      const out = createWriteStream(tmp);
      const written = new Promise<void>((resolve, reject) => {
        out.on('close', () => resolve());
        out.on('error', reject);
        zip.on('error', reject);
      });
      zip.outputStream.pipe(out);
      const pending: Array<Promise<unknown>> = [];

      for (const i of part.data) {
        const s = progress.staged[i]!;
        zip.addReadStreamLazy(`data/${s.policyId}.${pad3(s.n)}.jsonl`, { size: s.bytes }, (cb) => {
          this.storage.getStream(s.key).then((res) => cb(null, res.stream), (err: Error) => cb(err, null as unknown as Readable));
        });
      }
      for (const range of part.files) {
        const refs = (await this.readJsonl<LifecycleExportFileRef>(progress.staged[range.chunk]!.key)).slice(range.from, range.to + 1);
        const fresh = await this.db.fileObject.findMany({
          where: { id: { in: refs.map((f) => f.fileId) } },
          select: { id: true, ownerType: true, ownerId: true, deletedAt: true, status: true, storageKey: true, size: true },
        });
        const byId = new Map(fresh.map((f) => [f.id, f]));
        for (const ref of refs) {
          const f = byId.get(ref.fileId);
          if (!f || f.deletedAt || f.status !== 'ready') continue; // удалён после сбора — не уходит
          if (f.ownerType !== ctx.side || f.ownerId !== ctx.subjectId) {
            this.logger.error(`export ${r.id}: file ${f.id} does not belong to the ${ctx.side} any more — the build stops`);
            throw new LifecycleExportOwnerMismatch('FileObject');
          }
          const path = `files/${f.id}/${safeName(ref.name)}`;
          const stored = STORED_MIME.test(ref.mime);
          let resolveDone!: (v: { sha256: string; bytes: number }) => void;
          let rejectDone!: (e: unknown) => void;
          const done = new Promise<{ sha256: string; bytes: number }>((res, rej) => {
            resolveDone = res;
            rejectDone = rej;
          });
          pending.push(done.then((h) => fileEntries.push({ path, fileId: f.id, bytes: h.bytes, sha256: h.sha256 })));
          zip.addReadStreamLazy(path, { compress: !stored }, (cb) => {
            this.storage.getStream(f.storageKey).then(
              (res) => {
                const h = hashingStream(res.stream);
                h.done.then(resolveDone, rejectDone);
                cb(null, h.stream);
              },
              (err: Error) => {
                rejectDone(err);
                cb(err, null as unknown as Readable);
              },
            );
          });
        }
      }
      // Хэши файлов известны, когда yazl прочитал их потоки — манифест кладётся после
      await Promise.all(pending);
      if (last) {
        const manifest = await this.buildManifest(r, progress, fileEntries);
        zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json');
        zip.addBuffer(Buffer.from(this.readme(ctx.locale, r, manifest), 'utf8'), 'README.txt');
        await this.putJson(`${this.prefix(r.id)}manifest.json`, manifest);
      }
      zip.end();
      await written;
      const key = `${this.prefix(r.id)}part-${pad3(k + 1)}.zip`;
      const bytes = (await fs.stat(tmp)).size;
      const sha256 = await fileSha256(tmp);
      await this.storage.putFromFile(key, tmp, 'application/zip');
      if (!last && fileEntries.length) {
        const mkey = `${this.prefix(r.id)}staging/files-manifest.${pad3(k + 1)}.jsonl`;
        await this.putText(mkey, fileEntries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'application/x-ndjson');
        progress.fileManifests = [...(progress.fileManifests ?? []).filter((x) => x !== mkey), mkey];
      }
      progress.built = [...built, { key, bytes, sha256, downloads: 0 }];
      await this.save(r.id, progress);
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    return progress.built.length < progress.parts.length;
  }

  private async buildManifest(r: LifecycleExport, progress: ExportProgress, lastFiles: LifecycleExportManifestFile[]): Promise<LifecycleExportManifest> {
    const entries: LifecycleExportManifestEntry[] = progress.staged
      .filter((s) => s.kind === 'data')
      .map((s) => ({ path: r.mode === 'restore' ? s.key.slice(this.prefix(r.id).length) : `data/${s.policyId}.${pad3(s.n)}.jsonl`, policyId: s.policyId, rows: s.rows, bytes: s.bytes, sha256: s.sha256 }));
    const files: LifecycleExportManifestFile[] = [];
    for (const key of progress.fileManifests ?? []) files.push(...(await this.readJsonl<LifecycleExportManifestFile>(key)));
    files.push(...lastFiles);
    return {
      schema: LIFECYCLE_EXPORT_SCHEMA,
      mode: r.mode as LifecycleExportMode,
      exportId: r.id,
      subject: { type: r.subjectType as LifecycleExportSubjectType, id: r.subjectId },
      createdAt: r.createdAt.toISOString(),
      snapshotAt: (r.snapshotAt ?? r.createdAt).toISOString(),
      entries,
      files,
      skipped: progress.skipped,
      guarded: progress.guarded,
    };
  }

  /** README в языке заказчика: что в архиве и как читать маски. */
  private readme(locale: Locale, r: LifecycleExport, m: LifecycleExportManifest): string {
    const t = this.i18n.forLocale(locale);
    const fmt = this.i18n.format(locale);
    return [
      t(r.subjectType === 'user' ? 'lifecycle.export.readme.titleUser' : 'lifecycle.export.readme.titleWorkspace'),
      '',
      t('lifecycle.export.readme.created', { date: fmt.dateTime(r.createdAt) }),
      t('lifecycle.export.readme.contents', { tables: new Set(m.entries.map((e) => e.policyId)).size, rows: m.entries.reduce((a, e) => a + e.rows, 0), files: m.files.length }),
      t('lifecycle.export.readme.format'),
      t('lifecycle.export.readme.guarded'),
      t('lifecycle.export.readme.integrity'),
      '',
    ].join('\n');
  }

  private async putText(key: string, text: string, mime: string): Promise<void> {
    const tmp = appTmpPath(`export-obj-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`);
    await fs.writeFile(tmp, text);
    try {
      await this.storage.putFromFile(key, tmp, mime);
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  private putJson(key: string, value: unknown): Promise<void> {
    return this.putText(key, JSON.stringify(value, null, 2), 'application/json');
  }

  /**
   * Готово: одна транзакция — статус, части, срок, квота организации (факт байтов; сверх —
   * отказ `quota`), уведомление заказчику. Архив восстановления — манифест подписан (Ed25519).
   */
  private async finish(r: LifecycleExport, progress: ExportProgress): Promise<void> {
    const restore = r.mode === 'restore';
    let parts: LifecycleExportPart[];
    let manifest: LifecycleExportManifest | null = null;
    if (restore) {
      manifest = await this.buildManifest(r, progress, []);
      const sig = await this.signing.signRaw('lifecycle', lifecycleExportManifestPayload(manifest));
      manifest.signature = sig;
      await this.putJson(`${this.prefix(r.id)}manifest.json`, manifest);
      parts = progress.staged.filter((s) => s.kind === 'data').map((s) => ({ key: s.key, bytes: s.bytes, sha256: s.sha256, downloads: 0 }));
    } else {
      parts = progress.built ?? [];
    }
    const bytes = parts.reduce((a, p) => a + p.bytes, 0);
    const now = new Date();
    try {
      await this.db.$transaction(async (tx) => {
        const n = await tx.lifecycleExport.updateMany({
          where: { id: r.id, status: 'running' },
          data: {
            status: 'ready',
            readyAt: now,
            expiresAt: new Date(now.getTime() + LIFECYCLE_EXPORT_LIMITS.readyDays * DAY),
            parts: parts as unknown as Prisma.InputJsonValue,
            bytes: BigInt(bytes),
            rows: progress.rows,
            maxDownloads: Math.max(1, parts.length) * LIFECYCLE_EXPORT_LIMITS.maxDownloadsPerPart,
            manifest: (restore ? manifest : { schema: LIFECYCLE_EXPORT_SCHEMA, entries: progress.staged.filter((s) => s.kind === 'data').length, parts: parts.length }) as unknown as Prisma.InputJsonValue,
            progress: { ...progress, phase: 'finish' } as unknown as Prisma.InputJsonValue,
          },
        });
        if (!n.count) return;
        if (!restore && r.subjectType === 'workspace') await this.entitlements.consume(tx, { type: 'workspace', id: r.subjectId }, 'lifecycle.export.bytesPerDay', bytes);
        if (!restore) {
          await this.notifications.send(tx, {
            type: 'lifecycle.export.ready',
            to: [{ userId: r.requestedById }],
            payload: { subjectType: r.subjectType, parts: parts.length, sizeBytes: bytes, expiresOnIso: new Date(now.getTime() + LIFECYCLE_EXPORT_LIMITS.readyDays * DAY).toISOString().slice(0, 10) },
            ref: { type: 'lifecycle_export', id: r.id },
            actorId: null,
            workspaceId: r.subjectType === 'workspace' ? r.subjectId : null,
            idempotencyKey: `lifecycle.export.ready:${r.id}`,
          });
        }
      });
    } catch (err) {
      if (err && typeof err === 'object' && (err as { getStatus?: () => number }).getStatus?.() === 402) {
        await this.fail(r.id, 'quota');
        return;
      }
      throw err;
    }
    // Промежуточные куски больше не нужны (переносимый архив — части; восстановление — куски и есть данные)
    if (!restore) {
      for (const s of progress.staged) await this.storage.delete(s.key).catch(() => undefined);
      for (const k of progress.fileManifests ?? []) await this.storage.delete(k).catch(() => undefined);
    }
    this.emitUpdated(r, 'ready');
  }

  /** Провал сборки: статус, код, байты прочь, уведомление заказчику (переносимому). */
  async fail(id: string, code: LifecycleExportError, detail?: string): Promise<void> {
    const r = await this.db.lifecycleExport.findUnique({ where: { id } });
    if (!r) return;
    const changed = await this.db.$transaction(async (tx) => {
      const n = await tx.lifecycleExport.updateMany({ where: { id, status: { in: ['queued', 'running'] } }, data: { status: 'failed', errorCode: code } });
      if (!n.count) return false;
      if (r.mode === 'portable') {
        await this.notifications.send(tx, {
          type: 'lifecycle.export.failed',
          to: [{ userId: r.requestedById }],
          payload: { subjectType: r.subjectType, reasonLabelKey: `lifecycle.export.errors.${code}` },
          ref: { type: 'lifecycle_export', id },
          actorId: null,
          workspaceId: r.subjectType === 'workspace' ? r.subjectId : null,
          idempotencyKey: `lifecycle.export.failed:${id}`,
        });
      }
      return true;
    });
    if (!changed) return;
    if (code === 'internal' || code === 'owner_mismatch') this.logger.error(`export ${id} failed: ${code}${detail ? ` (${detail})` : ''}`);
    for (const key of exportObjectKeys(id, r.parts, r.progress)) await this.storage.delete(key).catch(() => undefined);
    this.emitUpdated(r, 'failed');
  }

  private emitUpdated(r: LifecycleExport, status: LifecycleExportStatus): void {
    if (r.mode !== 'portable') return;
    const payload: LifecycleExportUpdatedBusPayload = { exportId: r.id, subjectType: r.subjectType as LifecycleExportSubjectType, subjectId: r.subjectId, status, userIds: [r.requestedById] };
    this.events.emit(LIFECYCLE_BUS_EVENTS.exportUpdated, payload, 'lifecycle');
  }

  // ============================================================
  // Срок (шаги раннера)
  // ============================================================

  /**
   * Истёкшие архивы: сначала строка → `expired` (новых ссылок нет), потом байты; строка с
   * неудалёнными байтами (сбой хранилища) подбирается снова. Заморозка держит архив целиком.
   */
  private async expireBatch(limit: number, releasable: (tx: Tx, ids: readonly string[]) => Promise<string[]>): Promise<{ rows: number; more: boolean }> {
    const due = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM "lifecycle_exports"
       WHERE (status = 'ready' AND expires_at < now()) OR (status = 'expired' AND jsonb_array_length(parts) > 0)
       ORDER BY expires_at NULLS LAST LIMIT ${limit}`;
    if (!due.length) return { rows: 0, more: false };
    const free = await this.db.$transaction(async (tx) => {
      const ids = await releasable(tx, due.map((d) => d.id));
      if (ids.length) await tx.lifecycleExport.updateMany({ where: { id: { in: ids }, status: 'ready' }, data: { status: 'expired' } });
      return ids;
    });
    for (const id of free) {
      const r = await this.db.lifecycleExport.findUnique({ where: { id }, select: { parts: true, progress: true } });
      if (!r) continue;
      for (const key of exportObjectKeys(id, r.parts, r.progress)) await this.storage.delete(key);
      await this.db.lifecycleExport.update({ where: { id }, data: { parts: [] } });
    }
    return { rows: free.length, more: due.length === limit };
  }

  /** Строки заявок старше месяца (история страницы) и сборки, потерявшие джоб. */
  private async pruneBatch(limit: number, releasable: (tx: Tx, ids: readonly string[]) => Promise<string[]>): Promise<{ rows: number; more: boolean }> {
    const stale = await this.db.lifecycleExport.findMany({
      where: { status: { in: ['queued', 'running'] }, createdAt: { lt: new Date(Date.now() - STALE_BUILD_MS) } },
      select: { id: true },
      take: limit,
    });
    for (const s of stale) await this.fail(s.id, 'internal', 'build stalled (job lost)');
    const old = await this.db.lifecycleExport.findMany({
      where: { createdAt: { lt: new Date(Date.now() - LIFECYCLE_EXPORT_LIMITS.rowDays * DAY) } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    if (!old.length) return { rows: stale.length, more: false };
    const free = await this.db.$transaction((tx) => releasable(tx, old.map((o) => o.id)));
    const res = free.length ? await this.erasure.deleteExports({ id: { in: free } }) : { rows: 0 };
    return { rows: res.rows + stale.length, more: old.length === limit };
  }

  // ============================================================
  // Рич-карта
  // ============================================================

  private async renderCard(viewerId: string, exportId: string): Promise<RichCardPayload | null> {
    const r = await this.db.lifecycleExport.findUnique({ where: { id: exportId } });
    if (!r || r.mode !== 'portable') return null;
    if (r.requestedById !== viewerId) {
      if (r.subjectType !== 'workspace') return null;
      const role = await this.db.userRole.findFirst({ where: { userId: viewerId, context: 'workspace', tenantId: r.subjectId, isActive: true, role: { in: ['owner', 'admin'] } }, select: { id: true } });
      if (!role) return null;
    }
    const t = (key: string, values?: Record<string, string | number>) => this.i18n.translate(key, values);
    const fmt = this.i18n.format(this.locale());
    const dto = this.toDto(r, viewerId);
    const tone = dto.status === 'ready' ? 'success' : dto.status === 'failed' ? 'danger' : dto.status === 'expired' ? 'neutral' : 'accent';
    return {
      kind: 'rich_card',
      cardType: 'lifecycle_export',
      ref: { type: 'lifecycle_export', id: r.id },
      title: t(r.subjectType === 'user' ? 'lifecycle.export.card.titleUser' : 'lifecycle.export.card.titleWorkspace'),
      subtitle: fmt.dateTime(r.createdAt),
      icon: '📦',
      imageUrl: null,
      fields: [
        ...(dto.status === 'ready' ? [{ label: t('lifecycle.export.card.size'), value: this.i18n.bytes(dto.bytes) }] : []),
        ...(dto.status === 'ready' && dto.expiresAt ? [{ label: t('lifecycle.export.card.until'), value: fmt.dateTime(new Date(dto.expiresAt)) }] : []),
        ...(dto.status === 'ready' ? [{ label: t('lifecycle.export.card.parts'), value: String(dto.parts.length) }] : []),
      ],
      progress: dto.progress && dto.progress.total > 0 ? { current: dto.progress.done, target: dto.progress.total } : null,
      status: t(`lifecycle.export.status.${dto.status}`),
      statusTone: tone,
      actions: [],
      href: r.subjectType === 'workspace' ? `/workspaces/${r.subjectId}/profile/data/exports` : '/profile/my-data#exports',
    };
  }
}
