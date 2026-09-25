import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, ChatterEntry } from '@prisma/client';
import {
  CHATTER_LIMITS,
  CHATTER_PERSON_ID_KEYS,
  personRefProblems,
  redactPersonRefs,
  CHATTER_REGISTRY,
  ChatterActorLite,
  ChatterChange,
  ChatterEntryDto,
  ChatterPageDto,
  ChatterTypeMeta,
  ChronicleQueryInput,
  JournalQueryInput,
  chatterTypeKeysOf,
} from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { fullName } from '../../shared/utils/user-name';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { ChatterRefRegistry } from './chatter-ref.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
import { forbidden, notFound } from '../../shared/errors/api-error';
import { DELETED_USER_MARKER, renderChatter, chatterChangeDisplay, type ChatterRawKind } from '@superapp/i18n';

/** Тип джоба проекции плашки (core/jobs); payload = { entryId }, uniqueKey = `ce:<id>`. */
export const CHATTER_CHATPOST_JOB = 'chatter.chatpost';

type Tx = Prisma.TransactionClient;

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true, kind: true } as const;

/** Одна запись хроники на вход log/logMany */
export interface ChatterLogInput {
  refType: string;
  refId: string;
  workspaceId?: string | null;
  /** null/undefined = система (крон/движок) */
  actorId?: string | null;
  /** Снапшот имени актёра (переживает удаление аккаунта) */
  actorName?: string | null;
  /** Ключ CHATTER_REGISTRY ('task.deadline_changed', 'staff.role_changed'…) */
  typeKey: string;
  changes?: ChatterChange[] | null;
  payload?: Record<string, unknown> | null;
  /** Override chatPost из реестра (например, плашка только при наличии получателей) */
  chatPost?: boolean;
}

/** Спека отслеживаемых полей для diffTracked: поле → typeKey + подпись + форматтер */
export type ChatterTrackSpec<T> = Record<
  string,
  {
    typeKey: string;
    /**
     * СНАПШОТ подписи (фолбэк). Живая подпись живёт в каталоге —
     * `chatter.fields.<refType>.<field>`; зритель берёт её, если она там есть.
     */
    label: string;
    /** Значение → display-строка (null = «пусто»); сравнение идёт по результату */
    format: (row: T) => string | null;
    /**
     * СЫРОЕ значение (ISO-дата, число строкой) — чтобы зритель показал его
     * своими правилами региона, а не тем форматом, который запёкся при записи.
     * Не задано → в записи останутся только display-строки `format`.
     */
    raw?: (row: T) => string | null;
    /**
     * Как показывать сырое значение. Функция — когда вид зависит от самой строки:
     * у срока задачи это «дата» при allDay и «дата+время» иначе.
     */
    kind?: ChatterRawKind | ((row: T) => ChatterRawKind);
  }
>;

/**
 * core/chatter — 9-й платформенный движок: «Хроника записи».
 * Пишется СИНХРОННО из доменных сервисов (в их транзакции, где она есть) —
 * шина at-most-once и без old-значений для хроники не годится. Чтение — через
 * canView-резолвер потребителя (ChatterRefRegistry). Плашки контекстных чатов =
 * проекция записей ДЖОБОМ core/jobs, поставленным в той же транзакции, что и
 * запись (outbox): ретраи/бэкофф/dead-letter/redrive — у движка джобов, дедуп
 * повторного поста — у синка по chatterEntryId.
 */
@Injectable()
export class ChatterService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ChatterService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ChatterRefRegistry,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Стирание актора (реестр core/lifecycle: `ChatterEntry` — pseudonymize `actorName`): снимок
   * имени в записях человека заменяется маркером томбстоуна `DELETED_USER_MARKER` (как имя его
   * строки User; зритель видит метку на своём языке). Пачками по ctid — у активного человека сотни тысяч записей;
   * идемпотентно (уже заменённые не трогаются). Возвращает число изменённых строк.
   */
  async redactActor(userId: string, batch = 5000): Promise<number> {
    const label = DELETED_USER_MARKER;
    let total = 0;
    for (;;) {
      const n = await this.db.$executeRaw`
        UPDATE "chatter_entries" t SET "actor_name" = ${label}
          FROM (SELECT ctid FROM "chatter_entries"
                 WHERE "actor_id" = ${userId}::uuid AND "actor_name" IS DISTINCT FROM ${label}
                 LIMIT ${batch}) d
         WHERE t.ctid = d.ctid`;
      total += n;
      if (n < batch) break;
    }
    return total + (await this.redactPersonJson(userId, label));
  }

  /**
   * Имена человека ВНУТРИ записей, где он не актор: цель записи (`targetName` рядом с
   * `targetUserId`), заместитель (`deputyLabel` / `deputyUserId`), значения «было → стало»
   * (`from` / `to` рядом с `fromUserId` / `toUserId`). Строки находит GIN-индекс
   * `chatter_person_ids` (без скана таблицы); id остаётся — зритель рисует томбстоун.
   */
  private async redactPersonJson(userId: string, label: string, batch = 500): Promise<number> {
    let total = 0;
    let after = 0n;
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: bigint; payload: Prisma.JsonValue; changes: Prisma.JsonValue }>>`
        SELECT id, payload, changes FROM "chatter_entries"
         WHERE chatter_person_ids(payload, changes) @> ARRAY[${userId}]::text[] AND chatter_person_ids(payload, changes) <> '{}'::text[]
           AND id > ${after}
         ORDER BY id LIMIT ${batch}`;
      if (!rows.length) return total;
      await this.db.$transaction(async (tx) => {
        for (const r of rows) {
          const next = redactPersonRefs(r.payload, r.changes, userId, label);
          if (!next.changed) continue;
          await tx.chatterEntry.update({
            where: { id: r.id },
            data: {
              payload: next.payload === null ? Prisma.DbNull : (next.payload as Prisma.InputJsonValue),
              changes: next.changes === null ? Prisma.DbNull : (next.changes as Prisma.InputJsonValue),
            },
          });
          total++;
        }
      });
      after = rows[rows.length - 1]!.id;
      if (rows.length < batch) return total;
    }
  }

  /**
   * Имя человека в JSON записи — только парой с его id (`PERSON_NAME_REFS`): иначе стирание
   * его не найдёт. В деве и сьютах нарушение — ошибка (ловится сразу), в проде — журнал
   * (доменная операция не ломается из-за формы хроники).
   */
  private assertPersonRefs(entries: ChatterLogInput[]): void {
    for (const e of entries) {
      const problems = personRefProblems(e.payload, CHATTER_PERSON_ID_KEYS);
      for (const [i, c] of (e.changes ?? []).entries()) {
        if (c.fromUserId !== undefined && c.fromUserId !== null && typeof c.fromUserId !== 'string') problems.push(`changes[${i}].fromUserId is not an id`);
        if (c.toUserId !== undefined && c.toUserId !== null && typeof c.toUserId !== 'string') problems.push(`changes[${i}].toUserId is not an id`);
      }
      if (!problems.length) continue;
      const msg = `chatter ${e.typeKey}: person names without ids — ${problems.join('; ')}`;
      if (isDevEnv()) throw new Error(msg);
      this.logger.error(msg);
    }
  }

  /** Обработчик джоба проекции — регистрация до старта воркера (onApplicationBootstrap). */
  onModuleInit(): void {
    this.jobsRegistry.register(
      CHATTER_CHATPOST_JOB,
      (payload) => this.handleChatPostJob(payload),
      {
        maxAttempts: CHATTER_LIMITS.chatPostMaxAttempts,
        // Джоб может умереть по протухшей аренде — тогда catch обработчика (где
        // гасится needsChatPost) не выполнится, и запись навсегда останется в частичном
        // индексе chatter_entries_chat_post_pending_idx, который по замыслу держит ~0
        // строк, а бэкфилл будет поднимать её на каждом старте ближайшие сутки.
        onDiscard: (payload) => this.markChatPostDiscarded(String(payload.entryId ?? '')),
      },
    );
  }

  /**
   * Бэкфилл деплой-перехода: незапощенные записи БЕЗ джоба (дока-движковые строки,
   * потерянные/припруненные джобы) получают джоб. Окно redriveMaxAgeSec — как у
   * старого крон-редрайва: старше не догоняем (поздняя регистрация синка не должна
   * вылить историю залпом). Существующий джоб (живой ИЛИ терминальный) = не трогаем:
   * dead-letter — это решение «не переигрывать», а не потеря.
   */
  onApplicationBootstrap(): void {
    void this.backfillChatPostJobs().catch((err) =>
      this.logger.warn(`chat-post backfill failed: ${String((err as Error)?.message ?? err)}`),
    );
  }

  // ============================================================
  // Запись
  // ============================================================

  /**
   * Записать одну запись хроники. С tx — в транзакции мутации (ошибка валит
   * транзакцию целиком, как FinAuditLog); без tx — best-effort (ошибка хроники
   * никогда не ломает доменную операцию).
   */
  async log(tx: Tx | null, entry: ChatterLogInput): Promise<void> {
    return this.logMany(tx, [entry]);
  }

  /**
   * Была ли недавно такая же запись — сервисный предикат для потребителей, которые
   * склеивают повторяющиеся события (движок документов: не чаще одной плашки «правил
   * документ» в час на пару «человек + документ», иначе десять заходов подряд дают
   * десять одинаковых плашек в чате). Чтение своей таблицы остаётся внутри движка —
   * потребителю незачем знать её устройство.
   */
  async hasRecent(opts: {
    refType: string;
    refId: string;
    typeKey: string;
    actorId?: string | null;
    withinMs: number;
    payloadPath?: { path: string[]; equals: string };
  }): Promise<boolean> {
    const found = await this.db.chatterEntry.findFirst({
      where: {
        refType: opts.refType,
        refId: opts.refId,
        typeKey: opts.typeKey,
        ...(opts.actorId ? { actorId: opts.actorId } : {}),
        createdAt: { gte: new Date(Date.now() - opts.withinMs) },
        ...(opts.payloadPath ? { payload: opts.payloadPath } : {}),
      },
      select: { id: true },
    });
    return !!found;
  }

  /** Записать пачку записей (updateTask может дать несколько диффов за раз). */
  async logMany(tx: Tx | null, entries: ChatterLogInput[]): Promise<void> {
    if (entries.length === 0) return;
    const named = await this.withActorNames(tx, entries);
    this.assertPersonRefs(named);
    const data = named.map((e) => this.toRow(e));
    if (tx) {
      await this.createWithJobs(tx, data);
      return;
    }
    try {
      await this.createWithJobs(null, data);
    } catch (err) {
      this.logger.warn(
        `chatter log failed (non-fatal): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  /**
   * Снимок имени актёра, если потребитель его не передал.
   *
   * `actorName` — ВЕЧНОЕ поле записи: оно переживает удаление аккаунта и рендерится
   * шаблоном («{{actorName}} создал(а) объект»). Забытый снимок молча превращает всю
   * ленту в «Кто-то …», и заметно это только глазами. Дешевле один SELECT на пачку,
   * чем правило, которое каждый новый сервис обязан помнить.
   */
  private async withActorNames(tx: Tx | null, entries: ChatterLogInput[]): Promise<ChatterLogInput[]> {
    const needActor = entries.filter((e) => e.actorId && !e.actorName).map((e) => e.actorId!);
    // То же и для {{targetName}}: потребитель кладёт в payload только targetUserId
    // (id — вечен, имя — снимок), а шаблону нужно имя.
    const needTarget = entries
      .map((e) => (e.payload?.targetUserId && !e.payload?.targetName ? String(e.payload.targetUserId) : null))
      .filter((v): v is string => !!v);
    const missing = [...new Set([...needActor, ...needTarget])];
    if (missing.length === 0) return entries;
    const client = tx ?? this.db;
    const users = await client.user.findMany({
      where: { id: { in: missing } },
      select: { id: true, firstName: true, lastName: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, fullName(u)]));
    return entries.map((e) => {
      const next = { ...e };
      if (e.actorId && !e.actorName) next.actorName = nameOf.get(e.actorId) ?? null;
      const targetId = e.payload?.targetUserId;
      if (targetId && !e.payload?.targetName) {
        next.payload = { ...e.payload, targetName: nameOf.get(String(targetId)) ?? null };
      }
      return next;
    });
  }

  /**
   * Создать записи и — В ТОЙ ЖЕ транзакции — поставить джоб проекции плашки на
   * каждую запись с needsChatPost (outbox: откат мутации не оставляет ни записи,
   * ни джоба). uniqueKey `ce:<id>` дедупит против бэкфилла.
   */
  private async createWithJobs(
    tx: Tx | null,
    data: Prisma.ChatterEntryCreateManyInput[],
  ): Promise<void> {
    const client = tx ?? this.db;
    const created = await client.chatterEntry.createManyAndReturn({
      data,
      select: { id: true, needsChatPost: true },
    });
    for (const row of created) {
      if (!row.needsChatPost) continue;
      await this.jobs.enqueue(tx, {
        type: CHATTER_CHATPOST_JOB,
        payload: { entryId: row.id.toString() },
        uniqueKey: `ce:${row.id.toString()}`,
      });
    }
  }

  /**
   * Дифф отслеживаемых полей «было → стало» (чистая функция): по одной записи
   * на изменённое поле. Сравнение — по display-строкам форматтера (устойчиво
   * к Date/BigInt/enum-представлениям).
   */
  diffTracked<T>(
    spec: ChatterTrackSpec<T>,
    before: T,
    after: T,
  ): Array<{ typeKey: string; change: ChatterChange }> {
    const out: Array<{ typeKey: string; change: ChatterChange }> = [];
    for (const [field, def] of Object.entries(spec)) {
      const from = def.format(before);
      const to = def.format(after);
      if (from === to) continue;
      out.push({
        typeKey: def.typeKey,
        change: {
          field,
          label: def.label,
          from,
          to,
          // `raw` пишется рядом со снапшотом, а не вместо него: старые записи
          // (без raw) обязаны читаться, и фолбэк на display-строки — их путь.
          raw: def.raw
            ? {
                from: def.raw(before),
                to: def.raw(after),
                // Вид берём по состоянию ПОСЛЕ изменения: именно оно описывает то,
                // что человек видит сейчас в карточке.
                kind: typeof def.kind === 'function' ? def.kind(after) : def.kind ?? 'text',
              }
            : null,
        },
      });
    }
    return out;
  }

  // ============================================================
  // Проекция в чат (плашки) — джобы core/jobs
  // ============================================================

  /**
   * Обработчик джоба проекции: claim/ретраи/бэкофф/dead-letter — у движка джобов.
   * Идемпотентность: терминал chatPostedAt (повторный джоб = no-op) + дедуп синка
   * по chatterEntryId (второй ремень: краш между post и записью терминала).
   */
  private async handleChatPostJob(payload: Record<string, unknown>): Promise<void> {
    const entryId = BigInt(String(payload.entryId ?? '0'));
    const row = await this.db.chatterEntry.findUnique({ where: { id: entryId } });
    if (!row || !row.needsChatPost || row.chatPostedAt) return;

    const sink = this.registry.getSink(row.refType);
    if (!sink) {
      // Синки регистрируются в onModuleInit потребителей — до старта воркера.
      // Систематическое отсутствие (потребитель удалён) → бэкофф → dead-letter в логах.
      throw new Error(`no chat sink for refType "${row.refType}"`);
    }
    try {
      await sink.post(this.toDto(row));
    } catch (err) {
      // Родитель записи удалён (задачу снесли после мутации, породившей хронику):
      // постить плашку некуда и НИКОГДА не будет куда — это конец жизни проекции,
      // а не сбой. Без этой ветки движок жёг все попытки (~2ч бэкоффа) и хоронил
      // джоб error-логом + событием job.discarded, т.е. ложным инцидентом.
      // Сама запись хроники остаётся жить (она FK-free и переживает сущности) —
      // гасим только флаг её чат-проекции, чтобы строка ушла из pending-индекса.
      if (err instanceof NotFoundException) {
        await this.db.chatterEntry.updateMany({
          where: { id: entryId, chatPostedAt: null },
          data: { needsChatPost: false },
        });
        throw new JobDiscardError(
          `chatter ${entryId}: the parent ${row.refType}/${row.refId} is gone — the plaque is cancelled`,
        );
      }
      throw err;
    }
    await this.db.chatterEntry.updateMany({
      where: { id: entryId, chatPostedAt: null },
      data: { chatPostedAt: new Date() },
    });
  }

  /**
   * Джоб плашки похоронен (исчерпаны попытки ЛИБО смерть по аренде — тогда обработчик
   * не отрабатывал вовсе). Гасим флаг проекции: плашки не будет, но запись хроники
   * живёт дальше (она FK-free и самоценна). Иначе строка вечно висела бы в частичном
   * индексе pending-плашек и в окне бэкфилла на каждом старте.
   */
  private async markChatPostDiscarded(entryId: string): Promise<void> {
    if (!entryId) return;
    await this.db.chatterEntry
      .updateMany({
        where: { id: BigInt(entryId), chatPostedAt: null },
        data: { needsChatPost: false },
      })
      .catch(() => undefined);
  }

  /** Бэкфилл незапощенных записей без джоба (см. onApplicationBootstrap). */
  private async backfillChatPostJobs(): Promise<void> {
    const since = new Date(Date.now() - CHATTER_LIMITS.redriveMaxAgeSec * 1000);
    let cursor: bigint | null = null;
    for (;;) {
      const rows: Array<{ id: bigint }> = await this.db.chatterEntry.findMany({
        where: {
          needsChatPost: true,
          chatPostedAt: null,
          createdAt: { gt: since },
          ...(cursor !== null ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: CHATTER_LIMITS.chatPostBatch,
        select: { id: true },
      });
      if (rows.length === 0) return;

      const keys = rows.map((r) => `ce:${r.id.toString()}`);
      // Фильтр по статусу обязателен: (1) смысл — «занят ли ключ ЖИВЫМ джобом»,
      // терминальный занимать его не должен; (2) единственный индекс по unique_key —
      // партиальный jobs_unique_key_live (WHERE status IN ('available','executing')),
      // и без этого предиката запрос в него не попадает, превращаясь в seq-scan
      // таблицы jobs (а там 7 дней completed + 30 дней discarded).
      const existing = await this.db.job.findMany({
        where: {
          type: CHATTER_CHATPOST_JOB,
          uniqueKey: { in: keys },
          status: { in: ['available', 'executing'] },
        },
        select: { uniqueKey: true },
      });
      const have = new Set(existing.map((j) => j.uniqueKey));

      let enqueued = 0;
      for (const r of rows) {
        const key = `ce:${r.id.toString()}`;
        if (have.has(key)) continue;
        await this.jobs.enqueue(null, {
          type: CHATTER_CHATPOST_JOB,
          payload: { entryId: r.id.toString() },
          uniqueKey: key,
        });
        enqueued++;
      }
      if (enqueued > 0) this.logger.log(`chat-post backfill: enqueued ${enqueued} job(s)`);

      cursor = rows[rows.length - 1].id;
      if (rows.length < CHATTER_LIMITS.chatPostBatch) return;
    }
  }

  // ============================================================
  // Чтение
  // ============================================================

  /** Хроника одной записи. Доступ — canView-резолвер потребителя. */
  async list(
    viewerId: string,
    refType: string,
    refId: string,
    q: ChronicleQueryInput,
  ): Promise<ChatterPageDto> {
    const resolver = this.registry.get(refType);
    if (!resolver) {
      throw notFound('chatter.unknownRef');
    }
    const ok = await resolver.canView(viewerId, refId);
    if (!ok) throw forbidden('chatter.forbidden');

    return this.page({ refType, refId }, q.cursor, q.limit, viewerId);
  }

  /**
   * «Журнал организации» — сводный B2B-аудит воркспейса. Гейт (роль ≥ Менеджер;
   * Подрядчик отсечён рангом) — тот же зарегистрированный canView-резолвер 'workspace'
   * (единый источник правды доступа к хронике воркспейса; движок не держит доменную
   * ранг-логику и не тащит RolesService). Фильтр category → typeKey IN.
   */
  async listJournal(
    viewerId: string,
    workspaceId: string,
    q: JournalQueryInput,
  ): Promise<ChatterPageDto> {
    const resolver = this.registry.get('workspace');
    if (!resolver || !(await resolver.canView(viewerId, workspaceId))) {
      throw forbidden('chatter.journalForbidden');
    }

    const where: Prisma.ChatterEntryWhereInput = { workspaceId };
    if (q.category) where.typeKey = { in: chatterTypeKeysOf(q.category) };
    return this.page(where, q.cursor, q.limit, viewerId);
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  private async page(
    where: Prisma.ChatterEntryWhereInput,
    cursor?: string,
    limit?: number,
    viewerId?: string,
  ): Promise<ChatterPageDto> {
    const take = Math.min(limit ?? CHATTER_LIMITS.pageSize, CHATTER_LIMITS.maxPageSize);
    const rows = await this.db.chatterEntry.findMany({
      where: { ...where, ...(cursor ? { id: { lt: BigInt(cursor) } } : {}) },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const masked = await this.maskForViewer(viewerId ?? null, page);
    return {
      items: page.map((r, i) => this.toDto(r, masked[i])),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id.toString() : null,
      actors: await this.loadActors(page),
    };
  }

  /** Батч-обогащение актёров для PersonChip; удалённые/анонимизированные выпадают → фолбэк actorName. */
  private async loadActors(rows: ChatterEntry[]): Promise<Record<string, ChatterActorLite>> {
    const ids = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v))];
    if (ids.length === 0) return {};
    const users = await this.db.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: USER_LITE,
    });
    return Object.fromEntries(users.map((u) => [u.id, { ...u, kind: u.kind === 'bot' ? ('bot' as const) : ('person' as const) }]));
  }

  private toRow(e: ChatterLogInput): Prisma.ChatterEntryCreateManyInput {
    const meta = this.chatPostDefault(e.typeKey);
    return {
      refType: e.refType,
      refId: e.refId,
      workspaceId: e.workspaceId ?? null,
      actorId: e.actorId ?? null,
      actorName: e.actorName ?? null,
      typeKey: e.typeKey,
      changes: e.changes && e.changes.length > 0
        ? (e.changes as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      payload: e.payload
        ? (e.payload as Prisma.InputJsonValue)
        : Prisma.DbNull,
      // Плашка возможна только там, где у типа ссылки есть синк чата: без него джоб проекции
      // восемь раз ретраился бы и уходил в dead-letter на КАЖДОЙ записи (не падение, а шум и мусор)
      needsChatPost: (e.chatPost ?? meta) && !!this.registry.getSink(e.refType),
    };
  }

  private chatPostDefault(typeKey: string): boolean {
    // Неизвестный typeKey → false (безопасно: запись есть, плашки нет)
    return (CHATTER_REGISTRY as Record<string, ChatterTypeMeta>)[typeKey]?.chatPost ?? false;
  }

  /**
   * Строка в БД → DTO. `text` собирается ЗДЕСЬ, в языке запроса: запись вечна и
   * хранит только структуру (typeKey + payload + changes), поэтому один и тот же
   * факт читается по-казахски у одного человека и по-английски у другого, а
   * накопленная история переводится задним числом вместе с каталогом.
   */
  /**
   * «Было → стало» полей под правилами видимости — глазами зрителя (core/visibility): маска или
   * «скрыто». Строки без спеки refType и без таких полей не трогаются. Нет маскировщика или
   * зрителя — поля со спекой скрываются целиком (fail-closed).
   */
  private async maskForViewer(viewerId: string | null, rows: ChatterEntry[]): Promise<Array<ChatterChange[] | null | undefined>> {
    const masker = this.registry.getMasker();
    return Promise.all(
      rows.map(async (r) => {
        const changes = (r.changes as unknown as ChatterChange[] | null) ?? null;
        const spec = this.registry.get(r.refType)?.visibility;
        if (!changes || !spec || !changes.some((c) => spec.fieldMap[c.field])) return undefined;
        if (!masker || !viewerId) {
          return changes.map((c) => (spec.fieldMap[c.field] ? { ...c, from: null, to: null, raw: undefined, concealed: 'hidden' as const } : c));
        }
        try {
          return (await masker.mask(viewerId, spec, { refId: r.refId, workspaceId: r.workspaceId }, changes as never)) as ChatterChange[];
        } catch {
          return changes.map((c) => (spec.fieldMap[c.field] ? { ...c, from: null, to: null, raw: undefined, concealed: 'hidden' as const } : c));
        }
      }),
    );
  }

  private toDto(row: ChatterEntry, maskedChanges?: ChatterChange[] | null): ChatterEntryDto {
    const stored = maskedChanges !== undefined ? maskedChanges : ((row.changes as unknown as ChatterChange[] | null) ?? null);
    const payload = (row.payload as Record<string, unknown> | null) ?? null;
    const locale = this.i18n.locale;
    const t = this.i18n.forLocale(locale);
    const fmt = this.i18n.format(locale);
    const dash = t('common.labels.dash');
    // Те же значения, что уйдут в `text`: клиент ищет их в готовой фразе, чтобы
    // подменить чипами «было → стало».
    const changes = stored?.map((c) => ({ ...c, display: chatterChangeDisplay(c, t, fmt, dash) })) ?? null;
    return {
      id: row.id.toString(),
      refType: row.refType,
      refId: row.refId,
      workspaceId: row.workspaceId,
      actorId: row.actorId,
      actorName: row.actorName,
      typeKey: row.typeKey,
      changes,
      payload,
      text: renderChatter(
        this.i18n.forLocale(locale),
        row.typeKey,
        { refType: row.refType, actorName: row.actorName, changes, payload },
        this.i18n.format(locale),
      ),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
