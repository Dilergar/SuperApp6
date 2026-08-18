import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobsService } from '../jobs/jobs.service';
import { SignQrService } from './sign-qr.service';
import { SIGN_EXPIRED_JOB } from './sign.jobs';

/**
 * Гигиена движка подписи. Ретеншна здесь НЕТ и не будет: акты, протокол и
 * доказательства хранятся столько же, сколько сам документ (приказ № 279-НК —
 * до 75 лет). Крон только закрывает то, чего уже никто не ждёт.
 */
@Injectable()
export class SignCron {
  private readonly logger = new Logger(SignCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly qr: SignQrService,
    private readonly jobs: JobsService,
  ) {}

  /** Каждые 5 минут: погасить QR-сессии, которым вышел срок */
  @Cron('*/5 * * * *')
  async handleQrSessions(): Promise<void> {
    const n = await this.redis.withLock('cron:sign-qr-expire', 4 * 60 * 1000, () => this.qr.expireStale());
    if (n !== null && n > 0) this.logger.log(`QR-сессий закрыто по сроку: ${n}`);
  }

  /**
   * Ежечасно: заявки, которым вышел срок подписания.
   *
   * Сама заявка при этом НЕ УДАЛЯЕТСЯ и подписи из неё не пропадают: истёк срок
   * СБОРА подписей, а уже поставленные остаются доказательствами навсегда.
   */
  @Cron('19 * * * *')
  async handleExpiredRequests(): Promise<void> {
    const n = await this.redis.withLock('cron:sign-expire-requests', 10 * 60 * 1000, () => this.expireRequests());
    if (n !== null && n > 0) this.logger.log(`Заявок на подпись закрыто по сроку: ${n}`);
  }

  async expireRequests(): Promise<number> {
    const now = new Date();
    const rows = await this.db.signRequest.findMany({
      where: { status: 'pending', expiresAt: { lt: now } },
      select: { id: true },
      take: 200,
    });
    let closed = 0;
    for (const r of rows) {
      await this.db.$transaction(async (tx) => {
        // Порядок замков ТОТ ЖЕ, что у подписи и отказа: сначала акты, потом заявка.
        // Обратный порядок (сначала заявка) сталкивался бы с идущей финализацией
        // лоб в лоб — Postgres разрывал бы такую пару взаимоблокировкой, и падал бы
        // либо крон, либо живая подпись человека.
        await tx.signAct.updateMany({
          where: { requestId: r.id, status: 'pending' },
          data: { status: 'expired' },
        });
        // Незакрытые акты гашены тем же статусом: «ждёт подписи» у заявки, которой
        // уже нет, — состояние, из которого нет выхода.
        const won = await tx.signRequest.updateMany({
          where: { id: r.id, status: 'pending' },
          data: { status: 'expired', completedAt: now },
        });
        if (won.count === 0) return;
        // Разбудить ПОТРЕБИТЕЛЯ — джобом В ЭТОЙ ЖЕ транзакции (outbox): без хука
        // его предмет навсегда оставался бы «у контрагента», а сам крон про
        // статусы предметов не знает и знать не должен.
        await this.jobs.enqueue(tx, {
          type: SIGN_EXPIRED_JOB,
          payload: { requestId: r.id },
          uniqueKey: `signexp:${r.id}`,
        });
        closed++;
      });
    }
    return closed;
  }
}
