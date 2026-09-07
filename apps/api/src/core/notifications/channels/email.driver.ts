import { Injectable } from '@nestjs/common';
import type { EmailDriver, EmailMessage } from '../notifications.registry';

/**
 * Email — контракт драйвера без живой доставки: у платформы нет SMTP и верификации
 * почты (`User.email` необязателен и не подтверждается). В UI канал не показывается
 * (правило «UI несуществующих фич не показывать»); фанаут пишет `skipped:
 * driver_not_configured`. Живой драйвер встанет на это место без правок движка.
 */
@Injectable()
export class NullEmailDriver implements EmailDriver {
  readonly live = false;

  async send(_message: EmailMessage): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'driver_not_configured' };
  }
}
