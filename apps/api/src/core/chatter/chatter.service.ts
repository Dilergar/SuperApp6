import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, ChatterEntry } from '@prisma/client';
import {
  CHATTER_LIMITS,
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
import { DatabaseService } from '../../shared/database/database.service';
import { JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { ChatterRefRegistry } from './chatter-ref.registry';

/** Тип джоба проекции плашки (core/jobs); payload = { entryId }, uniqueKey = `ce:<id>`. */
export const CHATTER_CHATPOST_JOB = 'chatter.chatpost';

type Tx = Prisma.TransactionClient;

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

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
    label: string;
    /** Значение → display-строка (null = «пусто»); сравнение идёт по результату */
    format: (row: T) => string | null;
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
  ) {}

  /** Обработчик джоба проекции — регистрация до старта воркера (onApplicationBootstrap). */
  onModuleInit(): void {
    this.jobsRegistry.register(
      CHATTER_CHATPOST_JOB,
      (payload) => this.handleChatPostJob(payload),
      { maxAttempts: CHATTER_LIMITS.chatPostMaxAttempts },
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

  /** Записать пачку записей (updateTask может дать несколько диффов за раз). */
  async logMany(tx: Tx | null, entries: ChatterLogInput[]): Promise<void> {
    if (entries.length === 0) return;
    const data = entries.map((e) => this.toRow(e));
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
        change: { field, label: def.label, from, to },
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
      throw new Error(`нет chat-sink для refType "${row.refType}"`);
    }
    await sink.post(this.toDto(row));
    await this.db.chatterEntry.updateMany({
      where: { id: entryId, chatPostedAt: null },
      data: { chatPostedAt: new Date() },
    });
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
      const existing = await this.db.job.findMany({
        where: { type: CHATTER_CHATPOST_JOB, uniqueKey: { in: keys } },
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
      throw new NotFoundException('Хроника недоступна для этого типа записей');
    }
    const ok = await resolver.canView(viewerId, refId);
    if (!ok) throw new ForbiddenException('Нет доступа к хронике этой записи');

    return this.page({ refType, refId }, q.cursor, q.limit);
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
      throw new ForbiddenException('Журнал организации доступен с роли Менеджер');
    }

    const where: Prisma.ChatterEntryWhereInput = { workspaceId };
    if (q.category) where.typeKey = { in: chatterTypeKeysOf(q.category) };
    return this.page(where, q.cursor, q.limit);
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  private async page(
    where: Prisma.ChatterEntryWhereInput,
    cursor?: string,
    limit?: number,
  ): Promise<ChatterPageDto> {
    const take = Math.min(limit ?? CHATTER_LIMITS.pageSize, CHATTER_LIMITS.maxPageSize);
    const rows = await this.db.chatterEntry.findMany({
      where: { ...where, ...(cursor ? { id: { lt: BigInt(cursor) } } : {}) },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      items: page.map((r) => this.toDto(r)),
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
    return Object.fromEntries(users.map((u) => [u.id, u]));
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
      needsChatPost: e.chatPost ?? meta,
    };
  }

  private chatPostDefault(typeKey: string): boolean {
    // Неизвестный typeKey → false (безопасно: запись есть, плашки нет)
    return (CHATTER_REGISTRY as Record<string, ChatterTypeMeta>)[typeKey]?.chatPost ?? false;
  }

  private toDto(row: ChatterEntry): ChatterEntryDto {
    return {
      id: row.id.toString(),
      refType: row.refType,
      refId: row.refId,
      workspaceId: row.workspaceId,
      actorId: row.actorId,
      actorName: row.actorName,
      typeKey: row.typeKey,
      changes: (row.changes as unknown as ChatterChange[] | null) ?? null,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
