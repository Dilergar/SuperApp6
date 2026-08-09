import { Injectable, Logger } from '@nestjs/common';

/**
 * Мост QR-подписания через eGov Mobile (сервис Smart Bridge NITEC-S-5096).
 *
 * Поток, который описывает паспорт сервиса, короткий: мы публикуем ДВА
 * одноразовых HTTPS-URL — «забрать данные на подпись» и «положить подпись», —
 * кладём их в QR, человек сканирует его в eGov Mobile, приложение достаёт
 * данные, подписывает облачным ключом НУЦ (ст. 51 ЦК легализовала облачное
 * хранение закрытых ключей) и возвращает нам контейнер CMS.
 *
 * ВЕСЬ диалект JSON eGov mobile изолирован в ЭТОМ файле. Точный формат выдают
 * при регистрации ИС в каталоге sb.egov.kz, и когда он придёт — правится один
 * драйвер, а не движок: заявка, акт, протокол и проверка контейнера от формата
 * ссылки не зависят вовсе.
 *
 * До одобрения заявки драйвер работает в mock, и продукт живёт на NCALayer и
 * ПЭП — то есть госсогласование продукт не блокирует.
 */

export interface QrProcedureRequest {
  /** Публичный URL, откуда приложение заберёт данные на подпись */
  dataUrl: string;
  /** Публичный URL, куда приложение положит контейнер CMS */
  signUrl: string;
  /** Что человек увидит в приложении перед подписанием */
  description: string;
  /** Через сколько ссылки протухнут (требование паспорта: ограничение по времени) */
  expiresAt: Date;
}

export interface QrProcedureResult {
  /** Строка, которая кодируется в QR */
  deepLink: string;
  /** Идентификатор процедуры на стороне моста (если он его выдаёт) */
  procedureId?: string;
}

export interface SignQrDriver {
  readonly name: string;
  readonly live: boolean;
  createProcedure(req: QrProcedureRequest): Promise<QrProcedureResult>;
}

/**
 * Боевой мост. Точные адрес и тело запроса приходят вместе с одобрением заявки;
 * до этого момента здесь — известный из паспорта каркас: наш сервис регистрирует
 * процедуру, мост возвращает ссылку для QR.
 */
class SmartBridgeQrDriver implements SignQrDriver {
  readonly name = 'smartbridge';
  readonly live = true;
  private readonly logger = new Logger(SmartBridgeQrDriver.name);

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async createProcedure(req: QrProcedureRequest): Promise<QrProcedureResult> {
    const res = await fetch(`${this.baseUrl}/sign/procedure`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Схема авторизации моста задаётся при подключении; заголовки собраны в
        // одном месте намеренно — менять придётся ровно здесь.
        'x-client-id': this.clientId,
        'x-client-secret': this.clientSecret,
      },
      body: JSON.stringify({
        dataURL: req.dataUrl,
        signURL: req.signUrl,
        description: req.description,
        expiryDate: req.expiresAt.toISOString(),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Smart Bridge ${res.status}: ${text.slice(0, 300)}`);
      throw new Error('Сервис подписания eGov временно недоступен');
    }
    const json = (await res.json()) as { deepLink?: string; url?: string; procedureId?: string; id?: string };
    const deepLink = json.deepLink ?? json.url;
    if (!deepLink) throw new Error('Мост не вернул ссылку для QR');
    return { deepLink, procedureId: json.procedureId ?? json.id };
  }
}

/**
 * Mock-мост: QR ведёт на НАШ же одноразовый адрес подписи. Разработчику это даёт
 * рабочий сквозной путь без eGov (открыл ссылку — положил контейнер), а
 * verify-скрипту — способ сыграть за телефон.
 */
class MockQrDriver implements SignQrDriver {
  readonly name = 'mock';
  readonly live = false;

  async createProcedure(req: QrProcedureRequest): Promise<QrProcedureResult> {
    // Ссылка несёт ОБА адреса: mock существует ровно затем, чтобы разработчик
    // (и verify-скрипт) мог сыграть за телефон — сначала забрать данные, потом
    // положить подпись. Боевой мост оба адреса получает в теле запроса и в
    // ссылку их не кладёт.
    return { deepLink: `${req.signUrl}?data=${encodeURIComponent(req.dataUrl)}` };
  }
}

@Injectable()
export class SignQrBridgeService {
  private readonly logger = new Logger(SignQrBridgeService.name);
  readonly driver: SignQrDriver;

  constructor() {
    const url = (process.env.SMARTBRIDGE_URL ?? '').trim().replace(/\/+$/, '');
    const id = (process.env.SMARTBRIDGE_CLIENT_ID ?? '').trim();
    const secret = (process.env.SMARTBRIDGE_CLIENT_SECRET ?? '').trim();
    const requested = (process.env.SIGN_QR_DRIVER ?? '').trim().toLowerCase();
    const useBridge = requested === 'smartbridge' || (requested === '' && url.length > 0);

    if (useBridge && url && id && secret) {
      this.driver = new SmartBridgeQrDriver(url, id, secret);
      this.logger.log(`QR-мост eGov Mobile: smartbridge (${url})`);
    } else {
      this.driver = new MockQrDriver();
      if (useBridge && url) {
        this.logger.error(
          '🚨 SIGN_QR_DRIVER=smartbridge, но не заданы SMARTBRIDGE_CLIENT_ID/SECRET — работаю в mock.',
        );
      } else {
        this.logger.log('QR-мост eGov Mobile: mock (SMARTBRIDGE_URL не задан)');
      }
    }
  }

  get live(): boolean {
    return this.driver.live;
  }

  createProcedure(req: QrProcedureRequest): Promise<QrProcedureResult> {
    return this.driver.createProcedure(req);
  }
}
