import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IDEMPOTENCY_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { runInternal } from '../../shared/idempotency/binding';
import { utcTs } from '../../shared/database/sql-time';

type Tx = Prisma.TransactionClient;

export interface InboxRef {
  /** Источник: `livekit` | `telegram` | `scheduler` | … */
  source: string;
  /** Аккаунт/канал внутри источника (id бота, id комнаты, ключ расписания) */
  account: string;
  /** Идентификатор события У ИСТОЧНИКА (event.id, update_id, ключ периода) */
  eventId: string;
}

/**
 * Что делать приёмнику с событием:
 *  - `first` — видим впервые (либо прошлый обработчик умер посреди работы): обрабатываем,
 *    в конце зовём `done`, на сбое — `forget`;
 *  - `duplicate` — уже обработано: тихо отвечаем источнику 2xx;
 *  - `in_flight` — прямо сейчас обрабатывается другой доставкой: отвечаем НЕ-2xx, чтобы
 *    источник пришёл ещё раз. Ответить 2xx нельзя: первая доставка может упасть, снять
 *    отметку — а источник, услышав «принято», больше не придёт, и событие пропадёт.
 */
export type InboxVerdict = 'first' | 'duplicate' | 'in_flight';

/** Сейчас по часам БАЗЫ (колонки ящика — `timestamp` без пояса, в UTC). */
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

// ============================================================
// «Входящий ящик» — общий примитив «ровно один раз» для того, что приходит СНАРУЖИ
// и не несёт нашего ключа: вебхуки чужих систем и пакеты планировщика.
//
// ОПАСНОСТЬ, которую нельзя забыть: отметку ставят ТОЛЬКО ПОСЛЕ проверки подписи и
// окна времени. Иначе кто угодно отравит ящик поддельным `event.id`, и НАСТОЯЩЕЕ
// событие с тем же id будет молча выброшено как дубль.
//
// Два способа пользоваться:
//  - `once(tx)` — обработка целиком помещается в транзакцию вызывающего: отметка и
//    эффект коммитятся вместе, откат снимает обе;
//  - `begin` → обработка → `done` | `forget` — обработка в одну транзакцию НЕ помещается
//    (внутри сетевые вызовы). Между `begin` и `done` строка «в работе» под АРЕНДОЙ:
//    процесс, умерший посреди обработки (деплой, OOM), `forget` уже не позовёт, и без
//    аренды событие осталось бы помеченным навсегда — редоставка гасилась бы как дубль,
//    то есть «ровно один раз» превращалось в «не более одного». Аренда истекла ⇒
//    следующая доставка забирает событие себе.
// ============================================================

@Injectable()
export class IdempotencyInboxService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Страж «только в транзакции вызывающего». Типы этого не ловят: корневой клиент
   * структурно совместим с транзакционным. Отметка вне транзакции = событие может
   * быть помечено обработанным, хотя обработка откатилась (и наоборот).
   */
  private assertInTransaction(tx: Tx, method: string): void {
    if (typeof (tx as unknown as { $transaction?: unknown }).$transaction === 'function') {
      throw new Error(
        `IdempotencyInboxService.${method} must be called with the transaction client of the caller (tx), not the root database client`,
      );
    }
  }

  /**
   * `true` — событие видим ВПЕРВЫЕ, обработку продолжаем; `false` — дубль, вызывающий
   * обязан тихо выйти (и ответить источнику 200, иначе он будет слать ещё).
   *
   * Отметка ложится в ТУ ЖЕ транзакцию, что и обработка: откат обработки снимает и её,
   * поэтому строка сразу «обработана» (`done_at`). Брошенную строку «в работе» с
   * истёкшей арендой (её оставил `begin` умершего процесса) забираем себе.
   */
  async once(tx: Tx, ref: InboxRef): Promise<boolean> {
    this.assertInTransaction(tx, 'once');
    // ON CONFLICT, а не try/catch P2002: конфликт внутри транзакции Postgres
    // абортил бы ВСЮ транзакцию вызывающего (урок core/jobs.enqueue).
    const n = await tx.$executeRaw`
      INSERT INTO "idempotency_inbox" ("source", "account", "event_id", "received_at", "done_at")
      VALUES (${ref.source}, ${ref.account}, ${ref.eventId}, ${NOW}, ${NOW})
      ON CONFLICT ("source", "account", "event_id") DO UPDATE
        SET "received_at" = EXCLUDED."received_at", "done_at" = EXCLUDED."done_at"
        WHERE "idempotency_inbox"."done_at" IS NULL
          AND "idempotency_inbox"."received_at" < ${NOW} - make_interval(secs => ${IDEMPOTENCY_LIMITS.inboxLeaseSec}::int)`;
    return n > 0;
  }

  /**
   * Начать обработку события, которая не помещается в одну транзакцию. Строка встаёт
   * «в работе» под арендой `leaseSec`; вызывающий ОБЯЗАН закончить `done` (успех) либо
   * `forget` (сбой). Что делать с вердиктом — см. `InboxVerdict`.
   */
  begin(ref: InboxRef, opts: { leaseSec?: number } = {}): Promise<InboxVerdict> {
    const leaseSec = Math.max(1, Math.floor(opts.leaseSec ?? IDEMPOTENCY_LIMITS.inboxLeaseSec));
    return runInternal(async () => {
      const taken = await this.db.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO "idempotency_inbox" ("source", "account", "event_id", "received_at", "done_at")
        VALUES (${ref.source}, ${ref.account}, ${ref.eventId}, ${NOW}, NULL)
        ON CONFLICT ("source", "account", "event_id") DO UPDATE
          SET "received_at" = EXCLUDED."received_at"
          WHERE "idempotency_inbox"."done_at" IS NULL
            AND "idempotency_inbox"."received_at" < ${NOW} - make_interval(secs => ${leaseSec}::int)
        RETURNING "id"`;
      if (taken.length) return 'first';
      const rows = await this.db.$queryRaw<Array<{ done: boolean }>>`
        SELECT ("done_at" IS NOT NULL) AS done FROM "idempotency_inbox"
        WHERE "source" = ${ref.source} AND "account" = ${ref.account} AND "event_id" = ${ref.eventId}`;
      // Строки уже нет — её только что снял `forget` упавшей доставки: пусть источник
      // придёт ещё раз, следующая доставка станет первой
      return rows[0]?.done ? 'duplicate' : 'in_flight';
    });
  }

  /** Обработка удалась: событие обработано окончательно, редоставки — дубли. */
  done(ref: InboxRef): Promise<number> {
    return runInternal(() =>
      this.db.$executeRaw`
        UPDATE "idempotency_inbox" SET "done_at" = ${NOW}
        WHERE "source" = ${ref.source} AND "account" = ${ref.account} AND "event_id" = ${ref.eventId}
          AND "done_at" IS NULL`,
    );
  }

  /**
   * Снять отметку: обработка НЕ удалась, редоставка обязана пройти как первая. Снимает
   * только строку «в работе» — уже обработанное событие забыть нельзя (иначе сбой
   * поздней редоставки открывал бы дорогу второму эффекту).
   */
  forget(ref: InboxRef): Promise<number> {
    return runInternal(() =>
      this.db.$executeRaw`
        DELETE FROM "idempotency_inbox"
        WHERE "source" = ${ref.source} AND "account" = ${ref.account} AND "event_id" = ${ref.eventId}
          AND "done_at" IS NULL`,
    );
  }

  /**
   * Одна пачка ретенции ящика (шаг `idempotency.inbox` раннера core/lifecycle): строки,
   * полученные раньше `before`. Срок — политика `IdempotencyInbox` реестра; он обязан
   * превышать окно редоставки любого источника (иначе поздняя редоставка прошла бы вторым
   * эффектом).
   */
  pruneBatch(before: Date, limit: number): Promise<number> {
    return runInternal(() =>
      this.db.$executeRaw`
        DELETE FROM "idempotency_inbox"
        WHERE "id" IN (
          SELECT "id" FROM "idempotency_inbox"
          WHERE "received_at" < ${utcTs(before)}
          ORDER BY "received_at"
          LIMIT ${Math.max(1, Math.floor(limit))}::int
        )`,
    );
  }

  countBefore(before: Date): Promise<number> {
    return runInternal(async () => {
      const [r] = await this.db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "idempotency_inbox" WHERE "received_at" < ${utcTs(before)}`;
      return Number(r?.n ?? 0);
    });
  }
}
