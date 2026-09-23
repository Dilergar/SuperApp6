import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTOR_KIND_CODE,
  AUDIT_CATEGORY_CODE,
  AUDIT_CLIENT_CODE,
  AUDIT_LIMITS,
  AUDIT_OUTCOME_CODE,
  AUDIT_OUTCOMES,
  AUDIT_REGISTRY,
  AUDIT_SEVERITY_CODE,
  NOTIFICATION_REGISTRY,
  isAuditEventKey,
  type AuditActorKind,
  type AuditClient,
  type AuditDetailsOf,
  type AuditEventDef,
  type AuditEventKey,
  type AuditOutcome,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { DryRun } from '../../shared/context/dry-run.context';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import type { RequestContext } from '../../shared/context/request-context';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RedisService } from '../../shared/redis/redis.service';
import { incrWindow } from '../../shared/redis/incr-window';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { KeysMacService } from '../keys/keys.mac.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JobsService } from '../jobs/jobs.service';
import { AUDIT_BUS_EVENTS, AUDIT_EVENT_ENTITY, AUDIT_JOBS, AUDIT_NOTIFICATION_REF, AUDIT_REDIS } from './audit.constants';
import { AuditMetrics } from './audit.metrics';
import { AuditPartitions } from './audit.partitions';
import { canonicalIp, ipNetOf, normalizeAuditText, normalizeAuditValue } from './audit.redact';

type Tx = Prisma.TransactionClient;

/** Кто совершил действие. Род — из аутентификации (контекст запроса), не из тела запроса. */
export interface AuditActorInput {
  kind: AuditActorKind;
  id?: string | null;
  sessionId?: string | null;
  familyId?: string | null;
  keyId?: string | null;
  /** Сотрудник платформы действует от имени другого (заявка four-eyes, делегирование) */
  onBehalfOfId?: string | null;
  /** Снимок ролей актора (сотрудник платформы) */
  roles?: readonly string[] | null;
}

/** Контекст запроса явно — там, где ALS нет (гард до интерцептора, джоб, крон, скрипт). */
export type AuditCtxInput = Partial<Pick<RequestContext, 'requestId' | 'ip' | 'userAgent' | 'uaFamily' | 'deviceId' | 'country' | 'client' | 'route'>>;

export interface AuditRecordInput<K extends AuditEventKey> {
  key: K;
  /** По умолчанию `success` */
  outcome?: AuditOutcome;
  reasonCode?: string | null;
  /** Чья лента; по умолчанию — из `subjectFrom` паспорта */
  subjectUserId?: string | null;
  /** Организация — ТОЛЬКО явно: активная организация запроса сама в личное событие не попадает */
  workspaceId?: string | null;
  /** По умолчанию — актор аутентификации запроса; вне запроса — `system` */
  actor?: AuditActorInput;
  target?: { type: string; id: string; label?: string | null } | null;
  op?: string | null;
  details: AuditDetailsOf<K>;
  evidence?: Record<string, unknown> | null;
  ref?: { type: string; id: string } | null;
  related?: Record<string, unknown> | null;
  /** Явный контекст (перекрывает ALS) */
  ctx?: AuditCtxInput | null;
  /**
   * Уведомление паспорта (`notify`): `false` — не слать (продюсер шлёт своё сам); объект —
   * доп. параметры текста (`minutes`, `device`). По умолчанию — шлётся субъекту.
   */
  notify?: false | { params?: Record<string, string | number | boolean | null> };
  /**
   * Писать и в ПРЕДПРОСМОТРЕ команды Кабинета (`DryRun`): эффекты команды вне транзакции там
   * молчат, но само чтение сотрудника (предпросмотр = просмотр данных) — настоящий факт.
   */
  evenInPreview?: true;
}

export interface AuditRecorded {
  id: string;
  eventId: string;
  occurredAt: Date;
}

/** Записанное событие глазами наблюдателя (детекции, стрим наружу) — без шифротекстов. */
export interface AuditObservedEvent {
  id: string;
  eventId: string;
  occurredAt: Date;
  key: AuditEventKey;
  def: AuditEventDef;
  outcome: AuditOutcome;
  reasonCode: string | null;
  actorKind: string;
  actorId: string | null;
  subjectUserId: string | null;
  workspaceId: string | null;
  visWorkspace: boolean;
  ipHmac: string | null;
  targetType: string | null;
  targetId: string | null;
  country: string | null;
  client: string | null;
  uaFamily: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
}

/**
 * Наблюдатель записи. Регистрируется САМ (`audit.observe`) — движок не знает про детекции
 * и стрим, и конструкторы не замыкаются в цикл.
 *  - `inTx` — внутри транзакции факта (outbox наружу: откат факта = доставки нет);
 *  - `after` — вне критического пути, без ожидания (счётчики детекций: сбой не трогает факт).
 */
export interface AuditRecordObserver {
  inTx?(tx: Tx | null, e: AuditObservedEvent): Promise<void>;
  after?(e: AuditObservedEvent): void;
}

interface BuiltRow {
  data: Prisma.SecurityEventCreateManyInput;
  def: AuditEventDef;
  subjectUserId: string | null;
  notifyParams: Record<string, unknown> | null;
  input: AuditRecordInput<AuditEventKey>;
  /** Род актора и клиент словами (для наблюдателей; в строке — коды) */
  actorKind: string;
  client: string | null;
}

/** Метка ошибки «сбой уже посчитан» (вставка → best-effort не считает второй раз). */
const COUNTED = Symbol('auditFailureCounted');

const PLATFORM = { type: 'platform' } as const;
const aad = (field: string) => ({ entity: AUDIT_EVENT_ENTITY, field, ownerType: 'platform', ownerId: 'platform' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined): string | null => (v && UUID_RE.test(v) ? v.toLowerCase() : null);

/**
 * core/audit — журнал аудита безопасности (26-й движок). Контракт продюсера:
 *
 *   await audit.record(tx, { key, subjectUserId?, workspaceId?, actor?, target?, op?, outcome?,
 *                            reasonCode?, details, evidence?, ref?, ctx? });
 *
 * `tx` — транзакция ФАКТА: откат факта = записи нет, сбой записи = факт откатывается
 * (fail-closed для безопасности и денег). `null` — только там, где факта в БД нет вовсе
 * (неудачный вход, просмотр в Кабинете): тогда сбой записи всё равно поднимается —
 * вызывающий решает, fail-closed он (неудачный вход → 503) или best-effort (`recordBestEffort`).
 *
 * Детали — строго по схеме реестра (иначе Error: это ошибка разработчика, а не человека).
 * IP — envelope платформенным KEK + HMAC-псевдоним + сеть /24; сырой UA — только шифротекстом.
 * Уведомление паспорта шлётся субъекту в ТОЙ ЖЕ транзакции. Права движок НЕ проверяет —
 * кого записать, решает вызывающий (как у всех system*-методов движков).
 */
@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private batch: BuiltRow[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly observers = new Map<string, AuditRecordObserver>();

  constructor(
    private readonly db: DatabaseService,
    private readonly ws: WorkspaceContextService,
    private readonly envelope: KeysEnvelopeService,
    private readonly mac: KeysMacService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
    private readonly bus: EventBusService,
    private readonly redis: RedisService,
    private readonly partitions: AuditPartitions,
    private readonly metrics: AuditMetrics,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.flushBatch();
  }

  /** Подписать наблюдателя записи (детекции, стрим в SIEM). Имя — для перерегистрации. */
  observe(name: string, observer: AuditRecordObserver): void {
    this.observers.set(name, observer);
  }

  private observed(row: BuiltRow, created: AuditRecorded): AuditObservedEvent {
    const d = row.data;
    return {
      id: created.id,
      eventId: created.eventId,
      occurredAt: created.occurredAt,
      key: row.input.key,
      def: row.def,
      outcome: row.input.outcome ?? 'success',
      reasonCode: d.reasonCode ?? null,
      actorKind: row.actorKind,
      actorId: d.actorId ?? null,
      subjectUserId: row.subjectUserId,
      workspaceId: d.workspaceId ?? null,
      visWorkspace: d.visWorkspace === true,
      ipHmac: d.ipHmac ?? null,
      targetType: d.targetType ?? null,
      targetId: d.targetId ?? null,
      country: d.country ?? null,
      client: row.client,
      uaFamily: d.uaFamily ?? null,
      requestId: d.requestId ?? null,
      details: (d.details as Record<string, unknown>) ?? {},
    };
  }

  /** Наблюдатели «после записи» — без ожидания; сбой наблюдателя факт не трогает. */
  private notifyAfter(ev: AuditObservedEvent): void {
    for (const o of this.observers.values()) {
      if (!o.after) continue;
      try {
        o.after(ev);
      } catch (err) {
        this.logger.warn(`audit observer failed (${ev.key}): ${(err as Error).message}`);
      }
    }
  }

  // ============================================================
  // Запись
  // ============================================================

  async record<K extends AuditEventKey>(tx: Tx | null, input: AuditRecordInput<K>): Promise<AuditRecorded> {
    const row = await this.build(input as AuditRecordInput<AuditEventKey>);
    if (!tx && DryRun.active() && !input.evenInPreview) return { id: '0', eventId: '00000000-0000-0000-0000-000000000000', occurredAt: new Date() };
    const created = await this.insert(tx, row);
    await this.afterInsert(tx, row, created);
    return created;
  }

  /** Запись, чей сбой НЕ роняет вызывающего (журнал чтений Кабинета): метрика + лог. */
  async recordBestEffort<K extends AuditEventKey>(input: AuditRecordInput<K>): Promise<AuditRecorded | null> {
    try {
      return await this.record(null, input);
    } catch (err) {
      // Сбой вставки уже посчитан (`record`) — второй счёт удвоил бы порог деградации
      if (!(err as { [COUNTED]?: true })[COUNTED]) this.countFailure('best_effort');
      this.logger.warn(`audit best-effort write failed (${input.key}): ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Разовая запись по ключу дедупликации (кроны, повторные джобы): первая за `ttlSec` пишет,
   * остальные — no-op. Redis недоступен → пишем (лишняя строка лучше потерянной). Запись не
   * удалась → отметка снимается: иначе повтор крона считал бы событие записанным, и оно
   * пропадало бы навсегда. (В чужой транзакции откат ПОСЛЕ записи отметку не снимет —
   * вызывающие `recordOnce` с транзакцией сами дедуплицируют факт своей строкой.)
   */
  async recordOnce<K extends AuditEventKey>(tx: Tx | null, dedupeKey: string, input: AuditRecordInput<K>, ttlSec = 3 * 86_400): Promise<AuditRecorded | null> {
    const key = AUDIT_REDIS.once(dedupeKey);
    const won = await this.redis
      .getClient()
      .set(key, '1', 'EX', ttlSec, 'NX')
      .catch(() => 'OK');
    if (won !== 'OK') return null;
    try {
      return await this.record(tx, input);
    } catch (err) {
      await this.redis
        .getClient()
        .del(key)
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Схлопнутая запись шумных отказов (ключи API, перебор): в окне строки пишутся на счётчиках
   * 1, 10, 100, 1000… (лог-шкала) с `attempts` = счётчик — ≤ 4 строк на окно вместо тысяч,
   * порядок величины виден. Возвращает счётчик окна.
   */
  async recordCollapsed<K extends AuditEventKey>(collapseKey: string, windowSec: number, build: (attempts: number) => AuditRecordInput<K>): Promise<number> {
    let n = 1;
    try {
      n = await incrWindow(this.redis.getClient(), AUDIT_REDIS.collapse(collapseKey), windowSec);
    } catch {
      /* Redis недоступен — пишем каждую (n = 1) */
    }
    if (n === 1 || /^10*$/.test(String(n))) await this.recordBestEffort(build(n));
    return n;
  }

  /**
   * Наблюдаемая попытка БЕЗ строки журнала: вход во время блокировки не пишется построчно (флуд —
   * итог `audit.lockout_summary`), но детекции обязаны его видеть — иначе перебор «сверх
   * блокировки» (`bruteforce_account`) не сработал бы никогда: после 5-й неудачи строк больше нет.
   * Только наблюдатели `after` (счётчики Redis); без шифрования IP — строка не пишется.
   */
  async signal<K extends AuditEventKey>(input: AuditRecordInput<K>): Promise<void> {
    if (!this.observers.size) return;
    try {
      const row = await this.build(input as AuditRecordInput<AuditEventKey>, { light: true });
      this.notifyAfter(this.observed(row, { id: '0', eventId: '00000000-0000-0000-0000-000000000000', occurredAt: new Date() }));
    } catch (err) {
      this.logger.debug(`audit signal skipped (${input.key}): ${(err as Error).message}`);
    }
  }

  /**
   * Сбой записи: метрика процесса + общий счётчик минуты в Redis — детекция деградации журнала
   * (`audit_degraded`) складывает сбои ВСЕХ инстансов, а не того, кому достался лок крона.
   */
  private countFailure(path: string, n = 1): void {
    this.metrics.writeFailures.inc({ path }, n);
    void incrWindow(this.redis.getClient(), AUDIT_REDIS.writeFailures(Math.floor(Date.now() / 60_000)), 180, n).catch(() => undefined);
  }

  /**
   * Агрегаты высокой частоты (`pii.read`): буфер процесса, сброс раз в секунду или по 500
   * строк одной вставкой вне транзакции. Best-effort: сбой вставки — метрика и лог, чтение
   * данных человеку не ломается (так было и у прежнего журнала чтений ПДн).
   */
  async recordBatch<K extends AuditEventKey>(_tx: null, rows: Array<AuditRecordInput<K>>): Promise<void> {
    // Предпросмотр команды Кабинета здесь не глушится: агрегат — ЧТЕНИЯ, а чтение в предпросмотре настоящее
    if (!rows.length) return;
    for (const r of rows) {
      try {
        this.batch.push(await this.build(r as AuditRecordInput<AuditEventKey>));
      } catch (err) {
        this.countFailure('batch_build');
        this.logger.warn(`audit batch row rejected (${r.key}): ${(err as Error).message}`);
      }
    }
    if (this.batch.length >= AUDIT_LIMITS.batchMaxRows) {
      await this.flushBatch();
      return;
    }
    this.batchTimer ??= setTimeout(() => void this.flushBatch(), AUDIT_LIMITS.batchFlushMs);
  }

  async flushBatch(): Promise<void> {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    const rows = this.batch.splice(0, this.batch.length);
    if (!rows.length) return;
    try {
      await this.partitions.ensureFor(new Date());
      for (let i = 0; i < rows.length; i += AUDIT_LIMITS.batchMaxRows) {
        await this.db.securityEvent.createMany({ data: rows.slice(i, i + AUDIT_LIMITS.batchMaxRows).map((r) => r.data) });
      }
      for (const r of rows) {
        this.metrics.events.inc({ category: r.def.category, outcome: r.input.outcome ?? 'success' });
        // Агрегаты (`pii.read`) — тоже материал детекций (массовое чтение ПДн)
        this.notifyAfter(this.observed(r, { id: '0', eventId: String(r.data.eventId ?? ''), occurredAt: new Date() }));
      }
    } catch (err) {
      this.countFailure('batch', rows.length);
      this.logger.error(`audit batch of ${rows.length} rows failed: ${(err as Error).message}`);
    }
  }

  /** Число событий по фильтру за окно — пороги (серия отказов, бюджет чтений, фолбэк блокировки). */
  async count(filter: { key?: AuditEventKey | AuditEventKey[]; actorId?: string; subjectUserId?: string; outcome?: AuditOutcome; op?: string; sinceMs: number }): Promise<number> {
    const keys = filter.key === undefined ? undefined : Array.isArray(filter.key) ? filter.key : [filter.key];
    return this.db.securityEvent.count({
      where: {
        occurredAt: { gt: new Date(Date.now() - filter.sinceMs) },
        ...(keys ? { eventKey: { in: keys } } : {}),
        ...(filter.actorId ? { actorId: filter.actorId } : {}),
        ...(filter.subjectUserId ? { subjectUserId: filter.subjectUserId } : {}),
        ...(filter.outcome ? { outcome: AUDIT_OUTCOME_CODE[filter.outcome] } : {}),
        ...(filter.op ? { op: filter.op } : {}),
      },
    });
  }

  /** HMAC-псевдоним значения ключом `audit` (IP, неизвестный номер) — `sa6m:1:<kid>:<mac>`. */
  async pseudonym(value: string): Promise<string> {
    return this.mac.tagged('audit', value);
  }

  /**
   * Псевдонимы значения ВСЕМИ живыми версиями ключа `audit` — поиск «все события с этого IP»
   * сквозь ротацию (как pepper ключей API: строки прошлой версии ищутся её же `kid`).
   */
  async pseudonymsForSearch(value: string): Promise<string[]> {
    return this.mac.taggedAll('audit', canonicalIp(value) ?? value.trim());
  }

  // ============================================================
  // Сборка строки
  // ============================================================

  /** `light` — строка не пишется (сигнал наблюдателям): без шифротекстов IP и UA, только псевдоним. */
  private async build(input: AuditRecordInput<AuditEventKey>, opts: { light?: boolean } = {}): Promise<BuiltRow> {
    if (!isAuditEventKey(input.key)) throw new Error(`audit: unknown event key "${String(input.key)}" — declare it in packages/shared/src/audit`);
    const def = AUDIT_REGISTRY[input.key];
    const parsed = def.details.safeParse(input.details ?? {});
    if (!parsed.success) {
      throw new Error(`audit: details of ${input.key} do not match the registry schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.code}`).join('; ')}`);
    }
    const details = normalizeAuditValue(parsed.data) as Record<string, unknown>;
    const outcome = input.outcome ?? 'success';
    if (!(AUDIT_OUTCOMES as readonly string[]).includes(outcome)) throw new Error(`audit: bad outcome "${outcome}"`);

    const store = this.ws.get();
    const req = store?.request;
    const ctx = { ...(req ?? {}), ...(input.ctx ?? {}) } as Partial<RequestContext>;
    const actor = this.actorOf(input.actor, req);
    const subjectUserId = uuidOrNull(
      input.subjectUserId !== undefined
        ? input.subjectUserId
        : def.subjectFrom === 'actor' && (actor.kind === 'user' || actor.kind === 'platform_staff')
          ? (actor.id ?? null)
          : def.subjectFrom === 'target' && input.target?.type === 'user'
            ? input.target.id
            : null,
    );
    const workspaceId = uuidOrNull(input.workspaceId ?? null);

    const ip = canonicalIp(ctx.ip ?? null);
    const [ipEnc, ipHmac, uaRawEnc] = await Promise.all([
      ip && !opts.light ? this.envelope.encrypt(PLATFORM, aad('ip'), ip) : Promise.resolve(null),
      ip ? this.mac.tagged('audit', ip) : Promise.resolve(null),
      ctx.userAgent && !opts.light ? this.envelope.encrypt(PLATFORM, aad('userAgent'), ctx.userAgent.slice(0, 512)) : Promise.resolve(null),
    ]);
    const client: AuditClient | null = (ctx.client as AuditClient | undefined) ?? (req ? null : actor.kind === 'system' ? 'job' : null);

    const data: Prisma.SecurityEventCreateManyInput = {
      eventKey: input.key,
      op: input.op ? normalizeAuditText(input.op, 96) : null,
      category: AUDIT_CATEGORY_CODE[def.category],
      severity: AUDIT_SEVERITY_CODE[def.severity],
      outcome: AUDIT_OUTCOME_CODE[outcome],
      reasonCode: input.reasonCode ? normalizeAuditText(input.reasonCode, 64) : null,
      actorKind: AUDIT_ACTOR_KIND_CODE[actor.kind],
      actorId: uuidOrNull(actor.id ?? null),
      actorSessionId: uuidOrNull(actor.sessionId ?? null),
      actorFamilyId: uuidOrNull(actor.familyId ?? null),
      actorKeyId: uuidOrNull(actor.keyId ?? null),
      onBehalfOfId: uuidOrNull(actor.onBehalfOfId ?? null),
      actorRoles: actor.roles?.length ? ([...actor.roles] as Prisma.InputJsonValue) : Prisma.JsonNull,
      subjectUserId,
      workspaceId,
      targetType: input.target ? normalizeAuditText(input.target.type, 48) : null,
      targetId: input.target ? normalizeAuditText(input.target.id, 200) : null,
      // Подпись-снимок — только НЕ-человек: имя человека в журнал не пишется (карточка по id)
      targetLabel: input.target && input.target.type !== 'user' && input.target.label ? normalizeAuditText(input.target.label, 300) : null,
      related: input.related ? (normalizeAuditValue(input.related) as Prisma.InputJsonValue) : Prisma.JsonNull,
      visSubject: def.visibility.subject && !!subjectUserId,
      visWorkspace: def.visibility.workspace && !!workspaceId,
      visPlatform: true,
      ipEnc,
      ipHmac,
      ipNet: ipNetOf(ip),
      country: ctx.country && /^[A-Za-z]{2}$/.test(ctx.country) ? ctx.country.toUpperCase() : null,
      uaFamily: ctx.uaFamily ?? null,
      uaRawEnc,
      deviceId: uuidOrNull(ctx.deviceId ?? null),
      client: client ? AUDIT_CLIENT_CODE[client] : null,
      requestId: uuidOrNull(ctx.requestId ?? null),
      route: ctx.route ? ctx.route.slice(0, 200) : null,
      idempotencyKeyHash: store?.idem?.keyHash ? store.idem.keyHash.toString('hex') : null,
      details: details as Prisma.InputJsonValue,
      evidence: input.evidence ? (normalizeAuditValue(input.evidence) as Prisma.InputJsonValue) : Prisma.JsonNull,
      refType: input.ref ? normalizeAuditText(input.ref.type, 48) : null,
      refId: input.ref ? normalizeAuditText(input.ref.id, 200) : null,
    };
    // Параметры текста уведомления: устройство и место — ВСЕГДА (без гео-заголовка и UA — ключом
    // слова «неизвестно»: фраза в языке зрителя не рассыпается на пропущенном аргументе)
    const notifyParams =
      def.notify && input.notify !== false && subjectUserId
        ? {
            ...Object.fromEntries(Object.entries(details).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))),
            ...(req?.uaLabel ? { device: req.uaLabel } : { deviceKey: 'audit.unknownDevice' }),
            ...(data.country ? { whereCountry: data.country } : { whereKey: 'audit.unknownPlace' }),
            ...(input.notify ? (input.notify.params ?? {}) : {}),
          }
        : null;
    return { data, def, subjectUserId, notifyParams, input, actorKind: actor.kind, client };
  }

  /** Актор: явный → из аутентификации запроса → вне запроса система; до входа — аноним. */
  private actorOf(explicit: AuditActorInput | undefined, req: RequestContext | undefined): AuditActorInput {
    if (explicit) return explicit;
    if (req?.actor) return { kind: req.actor.kind, id: req.actor.id, sessionId: req.actor.sessionId, familyId: req.actor.familyId, keyId: req.actor.keyId, roles: req.actor.roles ?? null };
    return req ? { kind: 'anonymous' } : { kind: 'system' };
  }

  private async insert(tx: Tx | null, row: BuiltRow): Promise<AuditRecorded> {
    const select = { id: true, eventId: true, occurredAt: true } as const;
    if (tx) {
      // Партицию внутри чужой транзакции не создаём (DDL под её блокировками) — она заведена
      // заранее (`ensureAhead` на буте и кроном). Сбой записи откатывает факт: fail-closed.
      const r = await tx.securityEvent.create({ data: row.data, select });
      return { id: r.id.toString(), eventId: r.eventId, occurredAt: r.occurredAt };
    }
    try {
      const r = await this.db.securityEvent.create({ data: row.data, select });
      return { id: r.id.toString(), eventId: r.eventId, occurredAt: r.occurredAt };
    } catch (err) {
      if (!AuditPartitions.isMissingPartition(err)) {
        this.countFailure('record');
        if (err && typeof err === 'object') (err as { [COUNTED]?: true })[COUNTED] = true;
        throw err;
      }
      await this.partitions.ensureFor(new Date());
      const r = await this.db.securityEvent.create({ data: row.data, select });
      return { id: r.id.toString(), eventId: r.eventId, occurredAt: r.occurredAt };
    }
  }

  private async afterInsert(tx: Tx | null, row: BuiltRow, created: AuditRecorded): Promise<void> {
    const { def, input } = row;
    this.metrics.events.inc({ category: def.category, outcome: input.outcome ?? 'success' });
    if (this.observers.size) {
      const ev = this.observed(row, created);
      // Стрим наружу — в транзакции факта (outbox); сбой здесь откатывает факт, как и сама запись
      for (const o of this.observers.values()) if (o.inTx) await o.inTx(tx, ev);
      this.notifyAfter(ev);
    }
    // Уведомление паспорта — в той же транзакции (outbox движка уведомлений); без ссылок в
    // тексте, с причиной «почему вы это получили». SMS «нет живого push-устройства» — джобом
    // после коммита (сеть в транзакции запрещена), ≤ 1 в час.
    if (def.notify && row.notifyParams && row.subjectUserId) {
      await this.notifications.send(tx, {
        type: def.notify,
        to: [{ userId: row.subjectUserId }],
        payload: row.notifyParams,
        ref: { type: AUDIT_NOTIFICATION_REF.personal, id: created.id },
        actorId: row.data.actorId ?? null,
        includeActor: true,
        reason: 'system',
      });
      if (NOTIFICATION_REGISTRY[def.notify].smsEligible) {
        await this.jobs.enqueue(tx, {
          type: AUDIT_JOBS.smsAlert,
          payload: { userId: row.subjectUserId, notification: def.notify, eventId: created.id },
          uniqueKey: `sms:${row.subjectUserId}:${created.eventId}`,
        });
      }
    }
    // Живое обновление «Безопасности» человека: сигнал «перечитай» (at-most-once; до коммита
    // клиент не увидит ничего нового — поэтому сигнал с задержкой, когда запись в транзакции)
    if (row.data.visSubject && row.subjectUserId) {
      const userId = row.subjectUserId;
      const kind = def.category === 'session' || input.key.startsWith('auth.login') || input.key.startsWith('auth.logout') ? 'session' : 'event';
      const emit = () => this.bus.emit(AUDIT_BUS_EVENTS.recorded, { userId, kind, id: created.id }, 'audit');
      if (tx) setTimeout(emit, 1_500).unref?.();
      else emit();
    }
  }
}
