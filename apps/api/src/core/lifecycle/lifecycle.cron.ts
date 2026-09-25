import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { LifecycleCanaryService } from './lifecycle.canary';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleLooseFk } from './lifecycle.loose-fk';
import { LifecyclePartitions } from './lifecycle.partitions';
import { LifecyclePurgeRunner } from './lifecycle.purge';
import { LifecycleSettingsService } from './lifecycle.settings.service';
import { LifecycleDashboardService } from './lifecycle.dashboard.service';
import { LifecycleDbWatch } from './lifecycle.db-watch';

/**
 * Ночное обслуживание движка — в окне массового ретеншна 01:00–06:00 по Алматы (plan §6.1):
 * план прогонов сроков (джоб на политику), партиции журналов (вперёд, сброс по сроку,
 * ANALYZE родителей), здоровье → метрики. Loose FK — круглосуточно каждые 5 минут (удаление
 * родителя не ждёт ночи, хвосты детей — тоже). Стирание субъекта — круглосуточно: тик
 * оркестратора каждые 10 минут (ключи → окно бэкапов → сертификат, страховка потерянных
 * джобов, SLO), журнал стираний выгружается вне базы каждый час. Канарейка стирания — в 02:30
 * (джоб на сутки: синтетический человек и организация посеяны, стёрты, проверены). Вступившие
 * отложенные сокращения сроков организаций переносятся в действующий срок раз в час.
 * Под Redis-локом — один инстанс (`null` от withLock = лок занят, не результат).
 */
@Injectable()
export class LifecycleCron {
  private readonly logger = new Logger(LifecycleCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly partitions: LifecyclePartitions,
    private readonly purge: LifecyclePurgeRunner,
    private readonly looseFk: LifecycleLooseFk,
    private readonly erasure: LifecycleErasureService,
    private readonly canary: LifecycleCanaryService,
    private readonly settings: LifecycleSettingsService,
    private readonly dashboard: LifecycleDashboardService,
    private readonly dbWatch: LifecycleDbWatch,
  ) {}

  /**
   * Суточный снимок размеров по таблицам (дашборд «Данные»: рост, отставание сроков) — после
   * окна ретеншна, когда ночное удаление уже прошло.
   */
  @Cron('40 6 * * *', { timeZone: 'Asia/Almaty' })
  async storageSnapshot(): Promise<void> {
    const ran = await this.redis.withLock('cron:lifecycle-storage-snapshot', 30 * 60_000, async () => {
      const n = await this.dashboard.snapshotStorage();
      this.logger.log(`storage snapshot: ${n} table(s)`);
    });
    if (ran === null) this.logger.debug('storage snapshot skipped: lock held by another instance');
  }

  /** Вступившие отложенные сокращения — в действующий срок строки (принуждение учитывает их и без этого). */
  @Cron('7 * * * *')
  async settingsPromote(): Promise<void> {
    try {
      const n = await this.settings.promoteDue();
      if (n) this.logger.log(`retention settings: ${n} pending shortening(s) took effect`);
    } catch (err) {
      this.logger.warn(`retention settings promotion failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** План ночи: прогон каждой ведомой политики (джоб ждёт окна сам, живой дубль не ставится). */
  @Cron('10 1 * * *', { timeZone: 'Asia/Almaty' })
  async purgeNightly(): Promise<void> {
    const ran = await this.redis.withLock('cron:lifecycle-purge-plan', 10 * 60_000, async () => {
      const queued = await this.purge.planNightly();
      this.logger.log(`retention plan: ${queued} purge run(s) queued`);
    });
    if (ran === null) this.logger.debug('retention plan skipped: lock held by another instance');
  }

  @Cron('40 1 * * *', { timeZone: 'Asia/Almaty' })
  async partitionsNightly(): Promise<void> {
    const ran = await this.redis.withLock('cron:lifecycle-partitions', 30 * 60_000, async () => {
      const { dropped, health } = await this.partitions.maintain();
      const total = Object.values(dropped).reduce((n, l) => n + l.length, 0);
      this.logger.log(`partitions nightly: ${health.length} parents, ${total} partition(s) dropped by retention`);
    });
    if (ran === null) this.logger.debug('partitions nightly skipped: lock held by another instance');
  }

  /** Здоровье чаще, чем раз в сутки: метрика «вперёд < 2» должна загореться до полуночи месяца. */
  @Cron('17 */6 * * *')
  async partitionsHealth(): Promise<void> {
    await this.partitions.health();
  }

  /** Тик оркестратора стирания: этапы по сроку, сертификаты, redact организаций, застрявшие → метрика. */
  @Cron('*/10 * * * *')
  async erasureTick(): Promise<void> {
    const ran = await this.redis.withLock('cron:lifecycle-erasure-tick', 9 * 60_000, async () => {
      const r = await this.erasure.tick();
      if (r.keys || r.completed || r.requeued || r.redacted || r.legacy) this.logger.log(`erasure tick: ${JSON.stringify(r)}`);
    });
    if (ran === null) this.logger.debug('erasure tick skipped: lock held by another instance');
  }

  /** Журнал стираний вне базы (NDJSON в объектное хранилище): реплей после восстановления бэкапа. */
  @Cron('23 * * * *')
  async erasureJournalExport(): Promise<void> {
    const ran = await this.redis.withLock('cron:lifecycle-erasure-journal', 10 * 60_000, async () => {
      const n = await this.erasure.exportJournal();
      if (n) this.logger.log(`erasure journal: ${n} row(s) exported`);
    });
    if (ran === null) this.logger.debug('erasure journal export skipped: lock held by another instance');
  }

  /** Канарейка стирания: один прогон в сутки (uniqueKey дня; второй инстанс получит no-op). */
  @Cron('30 2 * * *', { timeZone: 'Asia/Almaty' })
  async canaryNightly(): Promise<void> {
    try {
      if (await this.canary.schedule()) this.logger.log('erasure canary queued');
    } catch (err) {
      this.logger.warn(`erasure canary was not queued: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Сторожевые метрики БД — КАЖДЫЙ инстанс без замка: сигнал есть у любого живого процесса
   * (замок оставил бы метрику у одного, и его смерть = тишина). Правила — `max without(instance)`.
   */
  @Cron('*/5 * * * *')
  async dbWatchTick(): Promise<void> {
    await this.dbWatch.refresh();
  }

  /** Loose FK: проход по учёту удалений (один живой джоб на кластер — uniqueKey) + метрика хвоста. */
  @Cron('*/5 * * * *')
  async looseFkTick(): Promise<void> {
    try {
      if ((await this.looseFk.backlog()) > 0) await this.looseFk.schedule();
    } catch (err) {
      this.logger.warn(`loose FK tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
