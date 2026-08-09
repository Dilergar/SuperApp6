import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SignOcspStatus } from '@superapp/shared';
import { isProdEnv } from '../../../shared/config/env.validation';

/**
 * Верификатор контейнера подписи (CMS/CAdES).
 *
 * Драйвер по образцу `SmsDriver` в core/verify: интерфейс + боевой + mock, выбор
 * по env, свойство `live`. Но fail-closed СТРОЖЕ, чем у SMS: в production при
 * mock-драйвере ЭЦП-акты ОТВЕРГАЮТСЯ, а не принимаются с предупреждением.
 * Непроверенная подпись юридически ничто — принять её значит выдать за ЭЦП то,
 * чем она не является. ПЭП при этом продолжает работать.
 *
 * Боевой драйвер обязан принимать ТРИ семейства алгоритмов сразу — ГОСТ
 * 34.310-2004, ГОСТ-2015 и RSA: старые сертификаты НУЦ доживают свой срок, и
 * отказ от них означал бы «ваш ключ не подходит» у половины страны.
 */

export interface SignCertificateInfo {
  subjectCn: string | null;
  /** ИИН физлица (в сертификатах НУЦ — в SERIALNUMBER субъекта как «IIN…») */
  iin: string | null;
  /** БИН организации — есть у ключей юрлица */
  bin: string | null;
  serial: string | null;
  issuerCn: string | null;
  notBefore: Date | null;
  notAfter: Date | null;
}

export interface CmsVerifyResult {
  /** Подпись математически верна И относится к предъявленным байтам */
  valid: boolean;
  /** Человеческая причина отказа (в лог и в протокол) */
  reason?: string;
  cert: SignCertificateInfo;
  /** Цепочка построена до корня НУЦ РК */
  chainValid: boolean;
  /** Статус сертификата в OCSP НА МОМЕНТ ПРОВЕРКИ (замораживается в акте) */
  ocsp: { status: SignOcspStatus; at: Date; raw?: Buffer } | null;
  /** Метка доверенного времени — она и есть юридическое время подписи */
  tsp: { at: Date; serial: string | null; raw?: Buffer } | null;
}

export interface SignVerifierDriver {
  readonly name: string;
  /** Настоящая криптография (не mock) */
  readonly live: boolean;
  /** Проверить ОТСОЕДИНЁННУЮ подпись над данными */
  verifyDetached(cms: Buffer, data: Buffer): Promise<CmsVerifyResult>;
}

/** Пустой сертификат — чтобы отказ не заставлял вызывающего проверять null */
export const EMPTY_CERT: SignCertificateInfo = {
  subjectCn: null,
  iin: null,
  bin: null,
  serial: null,
  issuerCn: null,
  notBefore: null,
  notAfter: null,
};

// ============================================================
// NCANode — боевой драйвер
// ============================================================

/**
 * NCANode (Java, MIT) — стандарт рынка КЗ для серверной проверки ЭЦП. Внутри у
 * него SDK KalkanCrypt НУЦ РК; его бинарники мы НЕ распространяем, образ
 * собирается приватно (рунбук `infra/sign-verifier/`).
 *
 * Весь диалект HTTP-ответа изолирован ЗДЕСЬ — как формат eGov mobile в QR-мосте.
 * Сменится верификатор — меняется один файл, контракт остаётся.
 */
class NcaNodeVerifier implements SignVerifierDriver {
  readonly name = 'ncanode';
  readonly live = true;
  private readonly logger = new Logger(NcaNodeVerifier.name);

  constructor(private readonly baseUrl: string) {}

  async verifyDetached(cms: Buffer, data: Buffer): Promise<CmsVerifyResult> {
    let json: NcaNodeResponse;
    try {
      const res = await fetch(`${this.baseUrl}/cms/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cms: cms.toString('base64'),
          data: data.toString('base64'),
          // Статус сертификата снимается ИМЕННО СЕЙЧАС и замораживается в акте:
          // приказ № 1187 требует проверки на момент подписания, а через год
          // OCSP-ответчик об этом сертификате уже ничего не скажет.
          checkOcsp: true,
          checkCrl: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return this.fail(`верификатор ответил ${res.status}: ${text.slice(0, 200)}`);
      }
      json = (await res.json()) as NcaNodeResponse;
    } catch (err) {
      // Недоступный верификатор — это НЕ «подпись плохая», но и не «подпись
      // хорошая»: акт не закрывается, человек пробует ещё раз.
      this.logger.error(`NCANode недоступен: ${(err as Error).message}`);
      throw new Error('Сервис проверки подписи временно недоступен');
    }

    if (json.status !== undefined && json.status !== 200 && json.status !== 0) {
      return this.fail(json.message || 'подпись не принята верификатором');
    }
    const signer = json.signers?.[0];
    if (!signer) return this.fail('в контейнере нет ни одной подписи');

    const certRaw = signer.certificates?.[0] ?? signer.cert ?? null;
    const cert = this.parseCert(certRaw);
    const ocspStatus = this.mapOcsp(signer.ocsp?.status ?? certRaw?.ocsp?.status);

    // ВЕРДИКТ ТОЛЬКО ПО ЯВНОМУ ПОДТВЕРЖДЕНИЮ.
    //
    // Здесь нельзя писать `!== false`: отсутствующее поле — это не «подпись
    // хорошая», а «верификатор про это ничего не сказал». Схема ответа NCANode
    // меняется между версиями, и при первом же расхождении имён (или ответе через
    // прокси) отрицательные проверки превратили бы непроверенный контейнер в
    // «квалифицированную подпись с подтверждённой цепочкой». Молчание = отказ.
    const explicitlyValid = json.valid === true || signer.valid === true;
    const explicitlyInvalid = json.valid === false || signer.valid === false;
    if (explicitlyInvalid) return this.fail(json.message ?? 'подпись недействительна');
    if (!explicitlyValid) {
      this.logger.error(
        `NCANode не подтвердил подпись явно (поля ответа: ${Object.keys(json).join(',')}; ` +
          `поля подписанта: ${Object.keys(signer).join(',')}) — трактую как отказ`,
      );
      return this.fail('верификатор не подтвердил подпись (неизвестный формат ответа)');
    }

    // Цепочка до корня НУЦ — отдельный вердикт, а не следствие «подпись верна»:
    // математически верная подпись самоподписанным ключом даёт valid=true и никакой
    // цепочки. Принимаем булев `true` и непустой массив цепочки; всё остальное,
    // включая отсутствие поля, — «не подтверждена» (её проверит гейт в submitCms).
    const chainValid = Array.isArray(certRaw?.chain)
      ? certRaw.chain.length > 0
      : certRaw?.chain === true;
    if (!chainValid) {
      this.logger.warn(
        `NCANode не подтвердил цепочку сертификата явно (chain=${JSON.stringify(certRaw?.chain ?? null)})`,
      );
    }

    return {
      valid: true,
      cert,
      chainValid,
      // Время вердикта OCSP — момент ЭТОЙ проверки: мы фиксируем, когда САМИ
      // спросили ответчик (revocationTime — это время отзыва, совсем другое поле,
      // и подставлять его сюда значило бы датировать проверку задним числом).
      ocsp: ocspStatus ? { status: ocspStatus, at: new Date() } : null,
      tsp: this.parseTsp(signer.tsp),
    };
  }

  /**
   * Метка доверенного времени. Неразобранная дата — это ОТСУТСТВИЕ метки, а не
   * повод подставить часы своего сервера: `tspAt` уходит в акт как юридическое
   * время подписания, и выдать за него системное время значит записать в вечное
   * доказательство неправду.
   */
  private parseTsp(tsp: NcaNodeTsp | undefined): { at: Date; serial: string | null } | null {
    const raw = tsp?.genTime ?? tsp?.date ?? null;
    if (!raw) return null;
    const at = this.parseDate(raw);
    if (!at) {
      this.logger.error(`NCANode вернул метку времени в неизвестном формате (${String(raw)}) — метка не записана`);
      return null;
    }
    return { at, serial: tsp?.serialNumber ?? null };
  }

  private fail(reason: string): CmsVerifyResult {
    return { valid: false, reason, cert: EMPTY_CERT, chainValid: false, ocsp: null, tsp: null };
  }

  /**
   * Разбор субъекта сертификата НУЦ РК. ИИН физлица лежит в SERIALNUMBER
   * («IIN123456789012»), БИН организации — в OU («BIN123456789012»); у части
   * сертификатов оба поля продублированы в отдельных атрибутах.
   */
  private parseCert(raw: NcaNodeCert | null): SignCertificateInfo {
    if (!raw) return EMPTY_CERT;
    const subject = raw.subject ?? {};
    const iin = subject.iin ?? this.extractCode(subject.serialNumber ?? subject.commonName, 'IIN');
    const bin = subject.bin ?? this.extractCode(subject.organizationalUnitName ?? subject.serialNumber, 'BIN');
    return {
      subjectCn: subject.commonName ?? null,
      iin: iin ?? null,
      bin: bin ?? null,
      serial: raw.serialNumber ?? null,
      issuerCn: raw.issuer?.commonName ?? null,
      notBefore: this.parseDate(raw.notBefore),
      notAfter: this.parseDate(raw.notAfter),
    };
  }

  private extractCode(source: string | null | undefined, prefix: 'IIN' | 'BIN'): string | null {
    if (!source) return null;
    const m = new RegExp(`${prefix}\\s*([0-9]{12})`, 'i').exec(source);
    return m ? m[1] : null;
  }

  private mapOcsp(status: string | undefined | null): SignOcspStatus | null {
    if (!status) return null;
    const s = status.toUpperCase();
    if (s === 'GOOD' || s === 'ACTIVE') return 'good';
    if (s === 'REVOKED' || s === 'SUSPENDED') return 'revoked';
    return 'unknown';
  }

  private parseDate(value: string | number | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}

interface NcaNodeTsp {
  genTime?: string | number;
  date?: string | number;
  serialNumber?: string;
}

interface NcaNodeCert {
  serialNumber?: string;
  notBefore?: string | number;
  notAfter?: string | number;
  /** Булев вердикт в одних версиях, построенная цепочка сертификатов — в других */
  chain?: boolean | unknown[];
  subject?: {
    commonName?: string;
    serialNumber?: string;
    organizationalUnitName?: string;
    iin?: string;
    bin?: string;
  };
  issuer?: { commonName?: string };
  ocsp?: { status?: string };
}

interface NcaNodeResponse {
  status?: number;
  message?: string;
  valid?: boolean;
  signers?: Array<{
    valid?: boolean;
    certificates?: NcaNodeCert[];
    cert?: NcaNodeCert;
    ocsp?: { status?: string; revocationTime?: string };
    tsp?: NcaNodeTsp;
  }>;
}

// ============================================================
// Mock — разработка и CI
// ============================================================

/**
 * Mock-верификатор: без сети и без криптографии. Принимает «контейнер» вида
 * base64(JSON) — так verify-скрипт управляет тем, ЧЕЙ ключ подписал и совпадает
 * ли подпись с документом, и проверяет ровно те ветки, ради которых движок и
 * написан (сверка ИИН, отказ по отозванному сертификату, несовпадение данных).
 *
 * ВАЖНО: в production этот драйвер ЭЦП не принимает вовсе — см. `ecpAccepted`.
 */
class MockVerifier implements SignVerifierDriver {
  readonly name = 'mock';
  readonly live = false;

  async verifyDetached(cms: Buffer, data: Buffer): Promise<CmsVerifyResult> {
    let payload: MockCms;
    try {
      payload = JSON.parse(cms.toString('utf8')) as MockCms;
    } catch {
      return {
        valid: false,
        reason: 'контейнер не разобран (mock ждёт JSON)',
        cert: EMPTY_CERT,
        chainValid: false,
        ocsp: null,
        tsp: null,
      };
    }

    const actualSha = createHash('sha256').update(data).digest('hex');
    // Если скрипт явно назвал отпечаток — сверяем: так проверяется главная
    // гарантия «подписано именно то, что показали».
    const dataMatches = !payload.sha256 || payload.sha256.toLowerCase() === actualSha;
    const now = new Date();

    return {
      valid: dataMatches && payload.valid !== false,
      reason: !dataMatches
        ? 'подпись относится к другому содержимому'
        : payload.valid === false
          ? (payload.reason ?? 'подпись недействительна')
          : undefined,
      cert: {
        subjectCn: payload.subjectCn ?? 'ТЕСТОВ ТЕСТ ТЕСТОВИЧ',
        iin: payload.iin ?? null,
        bin: payload.bin ?? null,
        serial: payload.serial ?? '00mock0000000001',
        issuerCn: payload.issuerCn ?? 'ҰЛТТЫҚ КУӘЛАНДЫРУШЫ ОРТАЛЫҚ (MOCK)',
        notBefore: new Date(now.getTime() - 86_400_000),
        notAfter: new Date(now.getTime() + 365 * 86_400_000),
      },
      chainValid: payload.chainValid !== false,
      ocsp: { status: (payload.ocspStatus as SignOcspStatus) ?? 'good', at: now },
      tsp: { at: now, serial: payload.tspSerial ?? '00mocktsp0001' },
    };
  }
}

interface MockCms {
  valid?: boolean;
  reason?: string;
  sha256?: string;
  subjectCn?: string;
  iin?: string;
  bin?: string;
  serial?: string;
  issuerCn?: string;
  chainValid?: boolean;
  ocspStatus?: string;
  tspSerial?: string;
}

// ============================================================
// Выбор драйвера
// ============================================================

@Injectable()
export class SignVerifierService {
  private readonly logger = new Logger(SignVerifierService.name);
  readonly driver: SignVerifierDriver;

  constructor() {
    const url = (process.env.NCANODE_URL ?? '').trim().replace(/\/+$/, '');
    const requested = (process.env.SIGN_VERIFY_DRIVER ?? '').trim().toLowerCase();
    const useNcaNode = requested === 'ncanode' || (requested === '' && url.length > 0);

    if (useNcaNode && url) {
      this.driver = new NcaNodeVerifier(url);
      this.logger.log(`Верификатор ЭЦП: ncanode (${url})`);
    } else {
      this.driver = new MockVerifier();
      if (isProdEnv()) {
        // Не warn, а error: в проде это значит, что ЭЦП принимать НЕЛЬЗЯ, и
        // движок именно так и поступит (см. ecpAccepted).
        this.logger.error(
          '🚨 Верификатор ЭЦП работает в MOCK — электронная подпись в production ОТВЕРГАЕТСЯ. ' +
            'Задайте NCANODE_URL (сборка образа — infra/sign-verifier/).',
        );
      } else {
        this.logger.log('Верификатор ЭЦП: mock (NCANODE_URL не задан)');
      }
    }
  }

  get live(): boolean {
    return this.driver.live;
  }

  /**
   * Принимаем ли ЭЦП вообще. Единственное место правила fail-closed: в
   * production с mock-верификатором подпись невозможно проверить, а
   * НЕПРОВЕРЕННАЯ подпись — это не «слегка хуже», это подделка под ЭЦП.
   */
  get ecpAccepted(): boolean {
    return this.driver.live || !isProdEnv();
  }

  verifyDetached(cms: Buffer, data: Buffer): Promise<CmsVerifyResult> {
    return this.driver.verifyDetached(cms, data);
  }
}
