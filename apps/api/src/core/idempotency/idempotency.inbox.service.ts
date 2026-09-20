import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IDEMPOTENCY_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { runInternal } from '../../shared/idempotency/binding';

type Tx = Prisma.TransactionClient;

export interface InboxRef {
  /** Источник: `livekit` | `telegram` | `scheduler` | … */
  source: string;
  /** Аккаунт/канал внутри источника (id бота, id комнаты, ключ расписания) */
  account: string;
  /** Идентификатор события У ИСТОЧНИКА (event.id, update_id, ключ периода) */
  eventId: string;
}

// ============================================================
// «Входящий ящик» — общий примитив «ровно один раз» для того, что приходит СНАРУЖИ
// и не несёт нашего ключа: вебхуки чужих систем и пакеты планировщика.
//
// ОПАСНОСТЬ, которую нельзя забыть: отметку ставят ТОЛЬКО ПОСЛЕ проверки подписи и
// окна времени. Иначе кто угодно отравит ящик поддельным `event.id`, и НАСТОЯЩЕЕ
// событие с тем же id будет молча выброшено как дубль.
// ============================================================

@Injectable()
export class IdempotencyInboxService {
  private readonly logger = new Logger(IdempotencyInboxService.name);

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
   * Отметка ложится в ТУ ЖЕ транзакцию, что и обработка: откат обработки снимает и её.
   */
  async once(tx: Tx, ref: InboxRef): Promise<boolean> {
    this.assertInTransaction(tx, 'once');
    // ON CONFLICT DO NOTHING, а не try/catch P2002: конфликт внутри транзакции Postgres
    // абортил бы ВСЮ транзакцию вызывающего (урок core/jobs.enqueue).
    const n = await tx.$executeRaw`
      INSERT INTO "idempotency_inbox" ("source", "account", "event_id")
      VALUES (${ref.source}, ${ref.account}, ${ref.eventId})
      ON CONFLICT ("source", "account", "event_id") DO NOTHING`;
    return n > 0;
  }

  /**
   * Снять отметку. Нужна там, где обработка НЕ живёт в одной транзакции с отметкой
   * (приёмник чужого вебхука со своими сетевыми вызовами): отметили — обработали —
   * упали ⇒ снимаем, иначе редоставка была бы молча выброшена как дубль.
   */
  forget(ref: InboxRef): Promise<number> {
    return runInternal(() =>
      this.db.$executeRaw`
        DELETE FROM "idempotency_inbox"
        WHERE "source" = ${ref.source} AND "account" = ${ref.account} AND "event_id" = ${ref.eventId}`,
    );
  }

  /**
   * Короткая транзакция «видим впервые?» для приёмников, у которых обработка не
   * помещается в одну транзакцию. Ответственность вызывающего — позвать `forget`,
   * если обработка не удалась.
   */
  firstTime(ref: InboxRef): Promise<boolean> {
    return runInternal(() => this.db.$transaction((tx) => this.once(tx, ref)));
  }

  /** Ретенция ящика: строка живёт дольше окна редоставки любого источника. */
  prune(): Promise<number> {
    return runInternal(() =>
      this.db.$executeRaw`
        DELETE FROM "idempotency_inbox"
        WHERE "id" IN (
          SELECT "id" FROM "idempotency_inbox"
          WHERE "received_at" < (now() AT TIME ZONE 'UTC') - make_interval(days => ${IDEMPOTENCY_LIMITS.inboxRetentionDays})
          LIMIT ${IDEMPOTENCY_LIMITS.sweepBatch}
        )`,
    );
  }
}
