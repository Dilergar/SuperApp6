import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { LedgerService } from './ledger.service';

/**
 * Nightly ledger invariant check (under a Redis lock — one instance per tick): per currency the
 * sum of EVERY account balance must be exactly 0 (mint comes from the issuance account, so money
 * is conserved by construction). A non-zero net means a leak/bug in a money path — it is logged
 * as an error loudly; this is the production replacement for reconcileCurrency being called only
 * by the verify-*.cjs scripts.
 */
@Injectable()
export class WalletCron {
  private readonly logger = new Logger(WalletCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ledger: LedgerService,
  ) {}

  @Cron('0 4 * * *')
  async reconcile() {
    const ran = await this.redis.withLock('cron:wallet-reconcile', 10 * 60 * 1000, async () => {
      // Инкрементально: валюта есть почти у каждого пользователя → полный проход ночью
      // был O(users) агрегатов. Σ=0 ломает только НОВЫЙ перевод, поэтому сверяем валюты
      // с движением с прошлого прогона (по BigInt-id журнала — он монотонный и по PK);
      // полный проход остаётся по воскресеньям и при отсутствии маркера (первый запуск).
      const MARKER = 'wallet:reconcile:last-max-id';
      const lastMaxRaw = await this.redis.get(MARKER).catch(() => null);
      const lastMax = lastMaxRaw ? BigInt(lastMaxRaw) : null;
      const { _max } = await this.db.ledgerTransfer.aggregate({ _max: { id: true } });
      const currentMax = _max.id ?? null;

      const fullSweep = new Date().getUTCDay() === 0 || lastMax === null;
      let currencies: Array<{ id: string; name: string }>;
      if (fullSweep) {
        currencies = await this.db.currency.findMany({ select: { id: true, name: true } });
      } else {
        const moved = await this.db.ledgerTransfer.findMany({
          where: { id: { gt: lastMax } },
          select: { currencyId: true },
          distinct: ['currencyId'],
        });
        currencies = moved.length
          ? await this.db.currency.findMany({
              where: { id: { in: moved.map((m) => m.currencyId) } },
              select: { id: true, name: true },
            })
          : [];
      }
      let broken = 0;
      for (const c of currencies) {
        const { net, ok } = await this.ledger.reconcileCurrency(c.id);
        if (!ok) {
          broken++;
          this.logger.error(
            `ЛЕДЖЕР РАСХОДИТСЯ: валюта «${c.name}» (${c.id}) Σ=${net} (должно быть 0) — расследовать немедленно`,
          );
        }
      }
      if (broken === 0) {
        this.logger.log(
          `Ledger reconcile (${fullSweep ? 'full' : 'incremental'}): ${currencies.length} валют, Σ=0 везде`,
        );
      }
      if (currentMax !== null) {
        await this.redis.set(MARKER, String(currentMax)).catch(() => undefined);
      }
      return broken;
    });
    if (ran === null) this.logger.debug('Skipped wallet reconcile — another instance holds the lock');
  }
}
