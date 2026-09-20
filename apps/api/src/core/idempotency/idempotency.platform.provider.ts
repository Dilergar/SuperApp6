import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  IDEMPOTENCY_LIMITS,
  idempotencyKeyLookupInputSchema,
  type IdempotencyKeyHitDto,
  type IdempotencyKeyLookupDto,
  type IdempotencyKeyLookupInput,
  type IdempotencyPersonPanelDto,
  type IdempotencyState,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { runInternal } from '../../shared/idempotency/binding';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';

/** Окно панели «спорные операции» — столько же, сколько живёт сама заявка. */
const PANEL_WINDOW_DAYS = IDEMPOTENCY_LIMITS.keyTtlDays;
const LOOKUP_LIMIT = 20;

/**
 * Раздел кабинета платформы (core/platform): ОДНА команда и ОДНА панель.
 *
 *  - `idempotency.key.lookup` — «мой запрос прошёл?» от интегратора: по сырому ключу
 *    находятся его заявки (ключ хэшируется, в журнал кабинета не попадает);
 *  - панель «Спорные операции» карточки 360 человека — сводка за окно.
 *
 * Тела ответов не раскрываются НИКОГДА: они лежат под KEK владельца, и спор решают
 * факты «сколько раз приходил, чем кончилось», а не содержимое.
 */
@Injectable()
export class IdempotencyPlatformProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
  ) {}

  onModuleInit(): void {
    this.commands.register<IdempotencyKeyLookupInput>({
      key: 'idempotency.key.lookup',
      version: 1,
      group: 'idempotency',
      titleKey: 'platform.commands.idempotencyKeyLookup.title',
      descriptionKey: 'platform.commands.idempotencyKeyLookup.description',
      input: idempotencyKeyLookupInputSchema,
      capability: 'platform.lookup.read',
      risk: 'medium',
      // Причина обязательна: разбор чужой операции — это чтение о человеке
      reasonRequired: true,
      // Сам ключ — секрет интегратора: в журнале кабинета остаётся только факт поиска
      redact: ['key'],
      // Чтение без последствий, поэтому предпросмотр = тот же ответ: оператор видит
      // результат прямо в модалке, ничего не исполняя
      dryRun: true,
      target: () => ({ type: 'idempotency_key', id: 'lookup' }),
      execute: async (_ctx, input) => ({ result: await this.lookup(input.key) }),
    });

    this.panels.register({
      key: 'user.idempotency',
      entity: 'user',
      titleKey: 'platform.panels.userIdempotency',
      capability: 'platform.lookup.read',
      order: 80,
      eager: false,
      load: async (_actor, id) => this.personSummary(id),
    });
  }

  /** Заявки по сырому ключу. Скоуп в поиске не участвует: он у каждого свой. */
  private async lookup(rawKey: string): Promise<IdempotencyKeyLookupDto> {
    const keyHash = createHash('sha256').update(rawKey, 'utf8').digest();
    const rows = await runInternal(() =>
      this.db.$queryRawUnsafe<
        Array<{
          method: string;
          route: string;
          principal: string;
          user_id: string | null;
          workspace_id: string | null;
          api_key_id: string | null;
          state: IdempotencyState;
          attempt: number;
          replays: number;
          http_status: number | null;
          error_code: string | null;
          resource_id: string | null;
          build: string | null;
          created_at: Date;
          completed_at: Date | null;
          has_body: boolean;
        }>
      >(
        `SELECT method, route, principal, user_id::text AS user_id, workspace_id::text AS workspace_id,
                api_key_id, state, attempt, replays, http_status, error_code, resource_id, build,
                created_at, completed_at, (response_id IS NOT NULL) AS has_body
         FROM idem.keys WHERE key_hash = $1 ORDER BY created_at DESC LIMIT ${LOOKUP_LIMIT}`,
        keyHash,
      ),
    );
    const hits: IdempotencyKeyHitDto[] = rows.map((r) => ({
      method: r.method,
      route: r.route,
      principal: r.principal,
      userId: r.user_id,
      workspaceId: r.workspace_id,
      apiKeyId: r.api_key_id,
      state: r.state,
      attempt: r.attempt,
      replays: r.replays,
      httpStatus: r.http_status,
      errorCode: r.error_code,
      resourceId: r.resource_id,
      build: r.build,
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at ? r.completed_at.toISOString() : null,
      hasBody: r.has_body,
    }));
    return { hits };
  }

  /** Сводка «спорных операций» человека за окно жизни заявки. */
  private async personSummary(userId: string): Promise<IdempotencyPersonPanelDto> {
    const rows = await runInternal(() =>
      this.db.$queryRawUnsafe<
        Array<{
          total: bigint;
          repeated: bigint;
          unresolved: bigint;
          committed_no_answer: bigint;
          released: bigint;
          last_at: Date | null;
        }>
      >(
        `SELECT
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE replays > 0)::bigint AS repeated,
           COUNT(*) FILTER (WHERE state = 'in_progress' AND (lease_until IS NULL OR lease_until < (now() AT TIME ZONE 'UTC')))::bigint AS unresolved,
           COUNT(*) FILTER (WHERE state = 'committed')::bigint AS committed_no_answer,
           COUNT(*) FILTER (WHERE state = 'released')::bigint AS released,
           MAX(last_seen_at) AS last_at
         FROM idem.keys
         WHERE user_id = $1::uuid AND created_at > (now() AT TIME ZONE 'UTC') - make_interval(days => $2::int)`,
        userId,
        PANEL_WINDOW_DAYS,
      ),
    );
    const r = rows[0];
    return {
      windowDays: PANEL_WINDOW_DAYS,
      total: Number(r?.total ?? 0),
      repeated: Number(r?.repeated ?? 0),
      unresolved: Number(r?.unresolved ?? 0),
      committedWithoutAnswer: Number(r?.committed_no_answer ?? 0),
      released: Number(r?.released ?? 0),
      lastAt: r?.last_at ? r.last_at.toISOString() : null,
    };
  }
}
