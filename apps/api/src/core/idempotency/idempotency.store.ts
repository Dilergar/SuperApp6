import { Injectable } from '@nestjs/common';
import { IDEMPOTENCY_LIMITS, type IdempotencyState } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { runInternal } from '../../shared/idempotency/binding';
import { idempotencyEnv, type IdempotencyPrincipalKind } from './idempotency.constants';

// ============================================================
// Хранилище заявок (`idem.keys`). Правда о ключе — СТРОКА В БАЗЕ, а не память
// процесса: каждый переход состояния status-guarded по (attempt, state), поэтому
// «коммит прошёл, ack потерян» не превращает финальный ответ в новое исполнение.
//
// Redis тут нет вовсе (решение грилла): кэш не авторитет, а лишний источник
// расхождения. Чтение — только с primary.
// ============================================================

export interface IdemKeyRow {
  user_id: string | null;
  principal: IdempotencyPrincipalKind;
  workspace_id: string | null;
  api_key_id: string | null;
  method: string;
  route: string;
  fingerprint: string;
  state: IdempotencyState;
  attempt: number;
  lease_expired: boolean;
  atomic: boolean;
  http_status: number | null;
  error_code: string | null;
  resource_id: string | null;
  response_id: bigint | null;
  response_at: Date | null;
  replays: number;
  build: string | null;
  created_at: Date;
  response_fresh: boolean;
}

export interface ClaimInput {
  scopeHash: Buffer;
  keyHash: Buffer;
  userId: string | null;
  principal: IdempotencyPrincipalKind;
  workspaceId: string | null;
  apiKeyId: string | null;
  method: string;
  route: string;
  fingerprint: string;
  atomic: boolean;
  leaseMs: number;
}

/**
 * Колонки строки + признаки, вычисленные в SQL по часам БАЗЫ: аренда и свежесть
 * снимка не вправе зависеть от часов процесса (их на флоте несколько).
 */
const SELECT_COLUMNS = `
  user_id::text AS user_id, principal, workspace_id::text AS workspace_id, api_key_id,
  method, route, fingerprint, state, attempt,
  (lease_until IS NULL OR lease_until < (now() AT TIME ZONE 'UTC')) AS lease_expired,
  atomic, http_status, error_code, resource_id, response_id, response_at, replays, build, created_at,
  (response_id IS NOT NULL AND response_at IS NOT NULL
     AND response_at > (now() AT TIME ZONE 'UTC') - make_interval(hours => RESPONSE_TTL_HOURS)) AS response_fresh`;

@Injectable()
export class IdempotencyStore {
  constructor(private readonly db: DatabaseService) {}

  /** Список колонок с подставленным окном снимка (число из env, не из запроса). */
  private columns(): string {
    return SELECT_COLUMNS.replace('RESPONSE_TTL_HOURS', String(idempotencyEnv().responseTtlHours));
  }

  /**
   * ПЕРВЫЙ ход по ключу: завести заявку ЛИБО прочитать уже существующую — одним
   * оператором и НИКОГДА не повисая на чужой транзакции.
   *
   * Почему не голый `INSERT … ON CONFLICT DO NOTHING`. Строку известного ключа держит
   * живая бизнес-транзакция первой попытки: отметка `committed` — это UPDATE внутри
   * неё. Проверка уникальности у INSERT видит «строку меняет незавершённая транзакция»
   * и ЖДЁТ её исхода (вдруг та удаляет строку) — то есть каждый повтор долгой ручки
   * висел до её коммита, занимая соединение пула. Двадцать параллельных повторов одним
   * ключом = двадцать занятых соединений: отказ в обслуживании одной кнопкой.
   *
   * Поэтому сначала MVCC-снимок (`existing` — он не блокируется ничем), а INSERT идёт
   * только когда строки в снимке НЕТ: вставка нуля строк проверку уникальности не зовёт.
   * Счётчик повторов — best-effort через `SKIP LOCKED`: строка занята ⇒ пропущен.
   *
   * `null` — редкая гонка двух ОДНОВРЕМЕННЫХ первых заявок: сосед вставил строку после
   * нашего снимка. Вызывающий перечитывает её (`seen`).
   */
  open(input: ClaimInput): Promise<{ claimed: boolean; row: IdemKeyRow } | null> {
    const env = idempotencyEnv();
    const cols = this.columns();
    return runInternal(async () => {
      const rows = await this.db.$queryRawUnsafe<Array<IdemKeyRow & { claimed: boolean }>>(
        `WITH existing AS (
           SELECT ${cols} FROM idem.keys WHERE scope_hash = $1 AND key_hash = $2
         ), ins AS (
           INSERT INTO idem.keys (
             scope_hash, key_hash, user_id, principal, workspace_id, api_key_id,
             method, route, fingerprint, state, attempt, lease_until, atomic, build,
             created_at, last_seen_at, expires_at
           )
           SELECT
             $1, $2, $3::uuid, $4, $5::uuid, $6,
             $7, $8, $9, 'in_progress', 1,
             (now() AT TIME ZONE 'UTC') + make_interval(secs => $10::double precision), $11::boolean, $12,
             (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'),
             (now() AT TIME ZONE 'UTC') + make_interval(days => $13::int)
           WHERE NOT EXISTS (SELECT 1 FROM existing)
           ON CONFLICT (scope_hash, key_hash) DO NOTHING
           RETURNING ${cols}
         ), bump AS (
           UPDATE idem.keys k SET replays = k.replays + 1, last_seen_at = (now() AT TIME ZONE 'UTC')
           FROM (
             SELECT scope_hash, key_hash FROM idem.keys
             WHERE scope_hash = $1 AND key_hash = $2 AND EXISTS (SELECT 1 FROM existing)
             FOR UPDATE SKIP LOCKED
           ) s
           WHERE k.scope_hash = s.scope_hash AND k.key_hash = s.key_hash
         )
         SELECT true AS claimed, ins.* FROM ins
         UNION ALL
         SELECT false AS claimed, existing.* FROM existing`,
        input.scopeHash,
        input.keyHash,
        input.userId,
        input.principal,
        input.workspaceId,
        input.apiKeyId,
        input.method,
        input.route,
        input.fingerprint,
        input.leaseMs / 1000,
        input.atomic,
        env.build,
        env.keyTtlDays,
      );
      const first = rows[0];
      if (!first) return null;
      const { claimed, ...row } = first;
      return { claimed, row };
    });
  }

  /**
   * Заявка: `INSERT … ON CONFLICT DO NOTHING RETURNING`. Запасной ход после `open`
   * (строку смела чистка между снимком и вставкой) — основной путь идёт через `open`. Голый INSERT с последующей
   * ловлей 23505 запрещён: каждый конфликт оставлял бы мёртвый кортеж и жёг XID.
   * Вернула строку — заявка НАША; вернула пусто — ключ уже известен.
   */
  claim(input: ClaimInput): Promise<IdemKeyRow | null> {
    const env = idempotencyEnv();
    return runInternal(async () => {
      const rows = await this.db.$queryRawUnsafe<IdemKeyRow[]>(
        `INSERT INTO idem.keys (
           scope_hash, key_hash, user_id, principal, workspace_id, api_key_id,
           method, route, fingerprint, state, attempt, lease_until, atomic, build,
           created_at, last_seen_at, expires_at
         ) VALUES (
           $1, $2, $3::uuid, $4, $5::uuid, $6,
           $7, $8, $9, 'in_progress', 1,
           (now() AT TIME ZONE 'UTC') + make_interval(secs => $10::double precision), $11, $12,
           (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'),
           (now() AT TIME ZONE 'UTC') + make_interval(days => $13::int)
         )
         ON CONFLICT (scope_hash, key_hash) DO NOTHING
         RETURNING ${this.columns()}`,
        input.scopeHash,
        input.keyHash,
        input.userId,
        input.principal,
        input.workspaceId,
        input.apiKeyId,
        input.method,
        input.route,
        input.fingerprint,
        input.leaseMs / 1000,
        input.atomic,
        env.build,
        env.keyTtlDays,
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Повторное обращение: прочитать строку и отметить его (`replays++`, `last_seen_at`).
   *
   * ЧТЕНИЕ НЕ БЛОКИРУЕТСЯ НИКОГДА. Строку держит живая бизнес-транзакция первой
   * попытки (отметка `committed` — это UPDATE внутри неё), и голый `UPDATE … RETURNING`
   * здесь ВИСЕЛ бы на её блокировке до самого коммита: двадцать параллельных повторов
   * долгой ручки = двадцать занятых соединений пула, то есть отказ в обслуживании
   * одним ключом. Поэтому SELECT идёт по MVCC-снимку, а счётчик — best-effort через
   * `FOR UPDATE SKIP LOCKED`: строка занята ⇒ инкремент пропущен, и это не беда.
   *
   * Один оператор: пишущий CTE исполняется всегда и до конца, а основной SELECT видит
   * снимок НА НАЧАЛО оператора — то есть состояние, которое уже закоммичено.
   */
  seen(scopeHash: Buffer, keyHash: Buffer): Promise<IdemKeyRow | null> {
    return runInternal(async () => {
      const rows = await this.db.$queryRawUnsafe<IdemKeyRow[]>(
        `WITH bump AS (
           UPDATE idem.keys k SET replays = k.replays + 1, last_seen_at = (now() AT TIME ZONE 'UTC')
           FROM (
             SELECT scope_hash, key_hash FROM idem.keys
             WHERE scope_hash = $1 AND key_hash = $2
             FOR UPDATE SKIP LOCKED
           ) s
           WHERE k.scope_hash = s.scope_hash AND k.key_hash = s.key_hash
         )
         SELECT ${this.columns()} FROM idem.keys WHERE scope_hash = $1 AND key_hash = $2`,
        scopeHash,
        keyHash,
      );
      return rows[0] ?? null;
    });
  }

  /** Строка как есть (без счётчика) — диагностика, dev-инъекции, Кабинет. */
  peek(scopeHash: Buffer, keyHash: Buffer): Promise<IdemKeyRow | null> {
    return runInternal(async () => {
      const rows = await this.db.$queryRawUnsafe<IdemKeyRow[]>(
        `SELECT ${this.columns()} FROM idem.keys WHERE scope_hash = $1 AND key_hash = $2`,
        scopeHash,
        keyHash,
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Перезахват брошенной заявки: аренда истекла (`in_progress`) либо прошлая попытка
   * ничего не сделала (`released`). `FOR UPDATE SKIP LOCKED` в подзапросе — чтобы
   * запрос не ВИСЕЛ на строке, которую держит живая транзакция другого процесса:
   * занята ⇒ ноль строк ⇒ честный `409 in_flight`.
   *
   * `fingerprint` заменяется только на перезахвате `released`: эффекта не было, и
   * исправленная форма с тем же ключом законна (человек починил поле и нажал ту же кнопку).
   */
  takeover(
    scopeHash: Buffer,
    keyHash: Buffer,
    expectedAttempt: number,
    opts: { leaseMs: number; atomic: boolean; fingerprint?: string },
  ): Promise<IdemKeyRow | null> {
    const env = idempotencyEnv();
    return runInternal(async () => {
      const rows = await this.db.$queryRawUnsafe<IdemKeyRow[]>(
        `UPDATE idem.keys k SET
           state = 'in_progress',
           attempt = k.attempt + 1,
           lease_until = (now() AT TIME ZONE 'UTC') + make_interval(secs => $4::double precision),
           http_status = NULL, error_code = NULL, resource_id = NULL,
           response_id = NULL, response_at = NULL, completed_at = NULL,
           atomic = $5,
           build = $6,
           fingerprint = COALESCE($7, k.fingerprint),
           last_seen_at = (now() AT TIME ZONE 'UTC'),
           expires_at = (now() AT TIME ZONE 'UTC') + make_interval(days => $8::int)
         FROM (
           SELECT scope_hash, key_hash FROM idem.keys
           WHERE scope_hash = $1 AND key_hash = $2 AND attempt = $3
             AND (state = 'released'
                  OR (state = 'in_progress' AND (lease_until IS NULL OR lease_until < (now() AT TIME ZONE 'UTC'))))
           FOR UPDATE SKIP LOCKED
         ) s
         WHERE k.scope_hash = s.scope_hash AND k.key_hash = s.key_hash
         RETURNING ${this.columns()}`,
        scopeHash,
        keyHash,
        expectedAttempt,
        opts.leaseMs / 1000,
        opts.atomic,
        env.build,
        opts.fingerprint ?? null,
        env.keyTtlDays,
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Продление аренды живым обработчиком (долгая ручка не теряет заявку).
   *
   * `SKIP LOCKED`: пока идёт бизнес-транзакция ЭТОГО ЖЕ запроса, строка заблокирована
   * её отметкой, и голый UPDATE висел бы на ней до коммита, занимая соединение пула
   * на каждый тик. Занята ⇒ пропускаем: перезахват её в это время всё равно не возьмёт.
   *
   * `committed` тоже продлевается: обработчик жив и после коммита (собирает ответ,
   * шлёт уведомления), и повтор в это окно обязан услышать «ещё идёт», а не «готово,
   * тела нет» — через секунду его ждёт настоящий ответ.
   */
  heartbeat(scopeHash: Buffer, keyHash: Buffer, attempt: number, leaseMs: number): Promise<number> {
    return runInternal(() =>
      this.db.$executeRawUnsafe(
        `UPDATE idem.keys k
         SET lease_until = (now() AT TIME ZONE 'UTC') + make_interval(secs => $4::double precision),
             last_seen_at = (now() AT TIME ZONE 'UTC')
         FROM (
           SELECT scope_hash, key_hash FROM idem.keys
           WHERE scope_hash = $1 AND key_hash = $2 AND attempt = $3 AND state IN ('in_progress', 'committed')
           FOR UPDATE SKIP LOCKED
         ) s
         WHERE k.scope_hash = s.scope_hash AND k.key_hash = s.key_hash`,
        scopeHash,
        keyHash,
        attempt,
        leaseMs / 1000,
      ),
    );
  }

  /**
   * Наблюдаемого эффекта не было — ключ свободен для честного повтора. Status-guarded:
   * если отметка уже легла (`committed`), release даёт 0 строк, и повтор получит
   * `already_completed`, а не новое исполнение.
   *
   * Отпущенная строка ничего не защищает (перезахват `released` ≡ новая заявка), она
   * нужна только поддержке — «запрос приходил, эффекта не было». Поэтому:
   *  - `forget` (гость, вебхук-триггер — принципал БЕЗ аккаунта): строка удаляется
   *    сразу. Иначе любой аноним растил бы `idem.keys` случайными токенами и ключами
   *    на публичной ручке — запись в базу без аутентификации, на неделю каждая;
   *  - остальным срок жизни сокращается до `releasedTtlHours`: клиент ставит ключ на
   *    КАЖДУЮ мутацию, и read-only POST'ы (поиск, предпросмотр) иначе составляли бы
   *    большинство строк таблицы, не защищая ничего.
   */
  release(scopeHash: Buffer, keyHash: Buffer, attempt: number, opts: { forget?: boolean } = {}): Promise<number> {
    return runInternal(() =>
      opts.forget
        ? this.db.$executeRawUnsafe(
            `DELETE FROM idem.keys
             WHERE scope_hash = $1 AND key_hash = $2 AND attempt = $3 AND state = 'in_progress'`,
            scopeHash,
            keyHash,
            attempt,
          )
        : this.db.$executeRawUnsafe(
            `UPDATE idem.keys SET state = 'released', lease_until = NULL, last_seen_at = (now() AT TIME ZONE 'UTC'),
               expires_at = LEAST(expires_at, (now() AT TIME ZONE 'UTC') + make_interval(hours => $4::int))
             WHERE scope_hash = $1 AND key_hash = $2 AND attempt = $3 AND state = 'in_progress'`,
            scopeHash,
            keyHash,
            attempt,
            IDEMPOTENCY_LIMITS.releasedTtlHours,
          ),
    );
  }

  /** Итог исполнения: ответ финален (успех либо отказ ПОСЛЕ коммита эффекта). */
  complete(
    scopeHash: Buffer,
    keyHash: Buffer,
    attempt: number,
    out: {
      httpStatus: number;
      errorCode: string | null;
      resourceId: string | null;
      responseId: bigint | null;
      responseAt: Date | null;
    },
  ): Promise<number> {
    return runInternal(() =>
      this.db.$executeRawUnsafe(
        `UPDATE idem.keys SET
           state = 'completed', lease_until = NULL,
           http_status = $4, error_code = $5, resource_id = $6,
           response_id = $7, response_at = $8::timestamptz AT TIME ZONE 'UTC',
           completed_at = (now() AT TIME ZONE 'UTC'), last_seen_at = (now() AT TIME ZONE 'UTC')
         WHERE scope_hash = $1 AND key_hash = $2 AND attempt = $3 AND state IN ('in_progress', 'committed')`,
        scopeHash,
        keyHash,
        attempt,
        out.httpStatus,
        out.errorCode,
        out.resourceId,
        out.responseId,
        out.responseAt,
      ),
    );
  }

  /**
   * Одна пачка чистки по сроку (шаг `idempotency.keys` раннера core/lifecycle — пачками,
   * массовый DELETE душит WAL и индекс). Срок строки — её `expires_at` (ставится при заявке).
   */
  sweepBatch(batch: number): Promise<number> {
    const limit = Math.max(1, Math.floor(batch));
    return runInternal(() =>
      this.db.$executeRawUnsafe(
        `DELETE FROM idem.keys
         WHERE (scope_hash, key_hash) IN (
           SELECT scope_hash, key_hash FROM idem.keys
           WHERE expires_at < (now() AT TIME ZONE 'UTC') LIMIT ${limit}
         )`,
      ),
    );
  }

  /** Сколько ключей просрочено (ожидание прогона раннера). */
  countExpired(): Promise<number> {
    return runInternal(async () => {
      const rows = await this.db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM idem.keys WHERE expires_at < (now() AT TIME ZONE 'UTC')`);
      return Number(rows[0]?.n ?? 0);
    });
  }

  /**
   * Сколько строк живёт сейчас (метрика). ОЦЕНКА планировщика (`reltuples` листьев),
   * а не `COUNT(*)`: точный счёт — полный проход всех 16 партиций каждые десять минут,
   * и на миллионах строк метрика стоила бы дороже того, что она измеряет. Автовакуум
   * листьев настроен по объёму изменений, поэтому оценка не отстаёт.
   */
  count(): Promise<number> {
    return runInternal(async () => {
      const rows = await this.db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COALESCE(SUM(GREATEST(c.reltuples, 0)), 0)::bigint AS n
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace ns ON ns.oid = p.relnamespace
         WHERE ns.nspname = 'idem' AND p.relname = 'keys'`,
      );
      return Number(rows[0]?.n ?? 0);
    });
  }
}
