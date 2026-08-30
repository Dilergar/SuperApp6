import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '@superapp/shared';
import { isDevEnv, isProdEnv } from '../../shared/config/env.validation';
import { trustedFetch } from '../../shared/http';

/**
 * SMS-слой движка подтверждений — реестр драйверов (паттерн STT-драйверов core/voice).
 *
 * Драйверы v1 (решение продукта): `kazinfoteh` (боевой — покрывает всех операторов КЗ,
 * самый дешёвый OTP-трафик, будущий WhatsApp-канал) и `mock` (dev/CI — код в лог).
 * Отправка СИНХРОННАЯ в запросе (НЕ core/jobs): пользователь ждёт SMS прямо сейчас,
 * а ретраить протухший код бессмысленно — упавший провайдер = честная ошибка сразу.
 *
 * Env: SMS_DRIVER=kazinfoteh|mock (пусто → mock + warn в production),
 *      KIT_USERNAME / KIT_PASSWORD / KIT_ORIGINATOR — креды и альфа-имя Kazinfoteh
 *      (все три обязательны при SMS_DRIVER=kazinfoteh), KIT_URL — адрес шлюза
 *      (по умолчанию боевой; вынесен в env под staging/смену хоста).
 */
export interface SmsSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface SmsDriver {
  readonly name: string;
  /** Реальная доставка настроена (mock → false: SMS никуда не уходит). */
  readonly live: boolean;
  send(phone: string, text: string): Promise<SmsSendResult>;
}

const SEND_TIMEOUT_MS = 10_000;
const KIT_DEFAULT_URL = 'https://kazinfoteh.org:9507/api';

/** Kazinfoteh HTTP API (docs.kazinfoteh.kz/protocols/http/outbox). */
class KazinfotehDriver implements SmsDriver {
  readonly name = 'kazinfoteh';
  readonly live = true;
  private readonly logger = new Logger('VerifySms');
  /** Тело ответа шлюза логируем один раз — чтобы сверить формат на живом аккаунте. */
  private formatLogged = false;

  constructor(
    private url: string,
    private username: string,
    private password: string,
    private originator: string,
  ) {}

  async send(phone: string, text: string): Promise<SmsSendResult> {
    const params = new URLSearchParams({
      action: 'sendmessage',
      username: this.username,
      password: this.password,
      recipient: phone.replace(/^\+/, ''), // международный формат без «+»
      messagetype: 'SMS:TEXT',
      originator: this.originator,
      messagedata: text,
    });
    try {
      // Параметры — ТЕЛОМ, не в query string: логин и пароль в URL оседают в логах
      // обратных прокси, APM и на стороне провайдера (одна из классических утечек
      // сервисных кредов). Шлюз принимает те же поля form-urlencoded.
      const res = await trustedFetch(
        this.url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        },
        { timeoutMs: SEND_TIMEOUT_MS, origin: 'env' },
      );
      const body = await res.text();
      // Ответ шлюза — XML: <statuscode>0</statuscode> + <statusmessage>…ACCEPTED…</statusmessage>.
      // Разбираем толерантно; точный формат сверяется на живом аккаунте — для этого
      // ПЕРВЫЙ ответ (успешный или нет) уходит в лог целиком, без кредов из тела запроса.
      const codeMatch = body.match(/<statuscode>\s*(\d+)\s*<\/statuscode>/i);
      const idMatch = body.match(/<messageid>\s*([^<]+)\s*<\/messageid>/i);
      const accepted = res.ok && (codeMatch ? codeMatch[1] === '0' : /accept/i.test(body));
      if (!this.formatLogged) {
        this.formatLogged = true;
        this.logger.log(
          `Kazinfoteh: первый ответ шлюза (сверьте разбор) — HTTP ${res.status}, ` +
            `распознано accepted=${accepted}, messageId=${idMatch?.[1] ?? '—'}; тело: ${body.slice(0, 500)}`,
        );
      }
      if (!accepted) {
        this.logger.warn(`Kazinfoteh отказ: HTTP ${res.status} ${body.slice(0, 300)}`);
        return { ok: false, error: `provider status ${codeMatch?.[1] ?? res.status}` };
      }
      return { ok: true, providerMessageId: idMatch?.[1]?.trim() };
    } catch (err) {
      this.logger.warn(`Kazinfoteh недоступен: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }
}

/** Dev/CI: SMS не отправляется, код виден в логе API — ТОЛЬКО в dev/test. */
class MockDriver implements SmsDriver {
  readonly name = 'mock';
  readonly live = false;
  private readonly logger = new Logger('VerifySms');

  async send(phone: string, text: string): Promise<SmsSendResult> {
    // Драйвер выбирается по СОВПАДЕНИЮ с 'kazinfoteh', то есть незаданный SMS_DRIVER
    // молча даёт mock — в том числе в проде. Раньше эта строка печатала живой OTP и
    // ПОЛНЫЙ номер: у кого есть доступ к логам (дежурный, агрегатор, экспорт, CI), у
    // того есть захват любого аккаунта через /verify/check → /auth/password-reset.
    // Логируем только в явном dev/test и с маскированным номером.
    // Гейт — именно development||test: CI поднимает API как 'test'.
    if (isDevEnv()) this.logger.log(`[mock] SMS → ${maskPhone(phone)}: ${text}`);
    return { ok: true };
  }
}

@Injectable()
export class VerifySmsService {
  private readonly logger = new Logger('VerifySms');
  readonly driver: SmsDriver;

  constructor() {
    const driverName = process.env.SMS_DRIVER || '';
    if (driverName === 'kazinfoteh') {
      // Все три поля обязательны по env-валидации: у альфа-имени нет разумного
      // дефолта — чужое имя отправителя шлюз просто отобьёт, а мы будем гадать.
      this.driver = new KazinfotehDriver(
        process.env.KIT_URL || KIT_DEFAULT_URL,
        process.env.KIT_USERNAME || '',
        process.env.KIT_PASSWORD || '',
        process.env.KIT_ORIGINATOR || '',
      );
    } else {
      this.driver = new MockDriver();
      if (isProdEnv()) {
        this.logger.warn(
          '⚠️  SMS_DRIVER не задан в production: SMS не отправляются (коды в лог НЕ пишутся). ' +
            'Реальные пользователи не смогут зарегистрироваться — настройте SMS_DRIVER=kazinfoteh.',
        );
      }
    }
  }

  get live(): boolean {
    return this.driver.live;
  }

  send(phone: string, text: string): Promise<SmsSendResult> {
    return this.driver.send(phone, text);
  }
}
