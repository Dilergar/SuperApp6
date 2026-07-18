import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FinancesService } from './finances.service';

/**
 * Разрыв связи в Окружении (удаление контакта / блок — блок тоже удаляет ContactLink) →
 * прямые user-гранты финансовых книг между парой отзываются (PRD: «при разрыве связей
 * приглашённый теряет доступ, данные остаются у владельца»). Гранты на Группы чистить не
 * нужно: членство в Группе умирает вместе со связью, живой circle-принципал гаснет сам.
 *
 * ВТОРОЙ ремень: основной путь — СИНХРОННЫЙ вызов из ContactsService (revokeFinbookSharesBetween,
 * через DI_TOKENS.FinancesService): шина ack'ает до хэндлера (at-most-once), потерянное событие
 * не должно навсегда оставлять доступ. Третий ремень — ночной свип FinancesCron.sweepShares.
 */
@Injectable()
export class FinancesEvents implements OnModuleInit {
  private readonly logger = new Logger(FinancesEvents.name);

  constructor(
    private readonly events: EventBusService,
    private readonly finances: FinancesService,
  ) {}

  onModuleInit(): void {
    // Разрыв связи через удаление контакта.
    this.events.on('contact.removed').subscribe((event) => {
      const p = event.payload as { userIds?: string[] };
      if (!p.userIds || p.userIds.length !== 2) return;
      this.revoke(p.userIds[0], p.userIds[1], 'contact.removed');
    });
    // Блокировка ТОЖЕ удаляет ContactLink, но эмитит своё событие с другим shape
    // (blockerId/blockedId). Без этой подписки заблокированный сохранял бы доступ к
    // расшаренной книге (resolveBook проверяет только core/access, не assertReachable).
    this.events.on('contact.blocked').subscribe((event) => {
      const p = event.payload as { blockerId?: string; blockedId?: string };
      if (!p.blockerId || !p.blockedId) return;
      this.revoke(p.blockerId, p.blockedId, 'contact.blocked');
    });
  }

  private revoke(a: string, b: string, source: string): void {
    void this.finances.revokeSharesBetween(a, b).catch((err) => {
      this.logger.warn(`finbook share revoke on ${source} failed: ${err?.message ?? err}`);
    });
  }
}
