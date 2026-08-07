import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { isDevEnv, isProdEnv } from '../../shared/config/env.validation';
import {
  VERIFY_LIMITS,
  VERIFY_ERROR_CODES,
  buildOtpSmsText,
  isKzMobilePhone,
  maskPhone,
  type VerifyPurpose,
  type VerifyStartResponse,
  type VerifyCheckResponse,
  type VerifyStatusResponse,
} from '@superapp/shared';
import { VerifySmsService } from './verify.sms';

/**
 * Движок подтверждений (core/verify, 11-й платформенный) — SMS-OTP.
 *
 * Цепочка (VerifyChallenge) = одна попытка подтвердить владение номером для одной цели.
 * Активная цепочка на (phone, purpose) одна; повторный start в живом TTL = ресенд
 * (НОВЫЙ код перезаписывает старый — Supabase-модель: храним только хэш, «переслать
 * тот же» невозможно и не нужно; attempts при этом НЕ сбрасываются — SuperTokens-модель).
 * После верной проверки выдаётся одноразовый verifyToken (64 hex), который потребитель
 * гасит consume() В ТРАНЗАКЦИИ своего действия (создание юзера / смена пароля / номера).
 *
 * Анти-абьюз: гео-щит (только казахстанские мобильные — там, где номер выбирает клиент),
 * кулдаун ресенда 60→120с (сервер отдаёт таймер), потолки на номер в БД (переживают
 * рестарт: час/сутки, окно по времени ОТПРАВКИ), per-IP счётчики в Redis (скользящее
 * окно, best-effort: Redis упал → warn и пропуск, номерные БД-лимиты продолжают
 * держать), глобальный часовой SMS-бюджет (стоп-кран денег, инкремент ПОСЛЕ реальной
 * отправки), 5 попыток ввода на цепочку, Redis-лок на (phone, purpose) от двойного
 * старта (два параллельных клика = две SMS = деньги).
 *
 * Тест-карта (Supabase-модель): VERIFY_TEST_PHONES="+7700…:111111,…" — SMS не шлётся,
 * принимается фиксированный код, лимиты не считаются (CI/verify-скрипты). В production
 * карта ИГНОРИРУЕТСЯ (фиксированный код = мгновенный захват номера), включить обратно
 * можно только явным VERIFY_TEST_PHONES_ALLOW_PROD=true.
 */

/** Цели, где номер выбирает КЛИЕНТ → нужен гео-щит (SMS-пампинг). */
const CLIENT_CHOSEN_PURPOSES = new Set<VerifyPurpose>([
  'register',
  'password_reset',
  'phone_change_new',
  // Гость внешней ссылки вводит свой номер сам → щит обязателен (решение продукта:
  // v1 — только казахстанские мобильные, иностранные подписанты позже).
  'share_link_guest',
]);

/** Как код был доставлен — метка на строке цепочки (аудит + отладка поддержки). */
type Delivery = 'sms' | 'simulated' | 'test_map';

interface StartOptions {
  /** Нейтральная имитация: цепочка настоящая, SMS не шлём, код недостижим. */
  simulate?: boolean;
}

@Injectable()
export class VerifyService {
  private readonly logger = new Logger(VerifyService.name);
  private readonly testPhones = new Map<string, string>();

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private sms: VerifySmsService,
  ) {
    // isProdEnv(): незаданный NODE_ENV — это ПРОД, а не «не прод». Иначе тест-карта с
    // фиксированными кодами пережила бы забытую переменную в контейнере.
    const isProd = isProdEnv();
    const allowInProd = process.env.VERIFY_TEST_PHONES_ALLOW_PROD === 'true';
    for (const pair of (process.env.VERIFY_TEST_PHONES || '').split(',')) {
      const [phone, code] = pair.split(':').map((s) => s.trim());
      if (phone && code && /^\d+$/.test(code)) this.testPhones.set(phone, code);
    }
    if (this.testPhones.size > 0 && isProd && !allowInProd) {
      this.logger.error(
        `🚨 VERIFY_TEST_PHONES задана в production (${this.testPhones.size} номеров) — ИГНОРИРУЮ. ` +
          'Фиксированный код + отключённые лимиты = мгновенный захват этих аккаунтов. ' +
          'Если это осознанный прод-смоук — VERIFY_TEST_PHONES_ALLOW_PROD=true.',
      );
      this.testPhones.clear();
    } else if (this.testPhones.size > 0 && isProd) {
      this.logger.warn(
        `⚠️  VERIFY_TEST_PHONES активна в production (${this.testPhones.size} номеров с фиксированным кодом) ` +
          'по явному VERIFY_TEST_PHONES_ALLOW_PROD=true.',
      );
    }
  }

  // ------------------------------------------------------------------
  // Режим движка
  // ------------------------------------------------------------------

  /**
   * Обязательно ли SMS-подтверждение для регистрации/сбросов.
   * Secure-by-default (паттерн троттлера): подтверждение обязательно ВЕЗДЕ, кроме явно
   * объявленного development/test; явный VERIFY_REQUIRED перекрывает в обе стороны
   * (true — тестировать полный путь в dev; false — аварийный рубильник, с громким warn).
   *
   * Раньше здесь стояло `=== 'production'`, и незаданная переменная ВЫКЛЮЧАЛА проверку:
   * регистрация принималась без verifyToken, а вместе с аккаунтом на чужой номер
   * доставались все его pending-приглашения (в том числе в организации).
   */
  get required(): boolean {
    const flag = process.env.VERIFY_REQUIRED;
    if (flag === 'true') return true;
    if (flag === 'false') return false;
    return isProdEnv();
  }

  status(): VerifyStatusResponse {
    return { required: this.required, smsEnabled: this.sms.live };
  }

  // ------------------------------------------------------------------
  // Запуск цепочки
  // ------------------------------------------------------------------

  /**
   * Публичный запуск (аноним): register | password_reset.
   * register: занятый номер → честный 409 (Kaspi-модель; enumeration и так доступна
   * через /users/lookup). password_reset: НЕсуществующий номер → НАСТОЯЩАЯ цепочка с
   * недостижимым кодом (SMS не шлём — деньги не тратим), поэтому все последующие
   * ответы — кулдаун, 429, «осталось попыток N», тайминг — совпадают с ответами по
   * живому аккаунту; раньше пустышка отвечала мгновенно и никогда не упиралась в
   * лимиты, что само по себе было ответом «такого номера нет».
   */
  async startPublic(phone: string, purpose: 'register' | 'password_reset', ip?: string): Promise<VerifyStartResponse> {
    if (purpose === 'register') {
      const existing = await this.db.user.findUnique({ where: { phone }, select: { deletionScheduledAt: true, deletedAt: true } });
      if (existing) {
        if (existing.deletionScheduledAt && !existing.deletedAt) {
          throw new ConflictException('Этот номер привязан к аккаунту, помеченному на удаление. Войдите, чтобы восстановить его.');
        }
        throw new ConflictException('Этот номер телефона уже зарегистрирован');
      }
      return this.startChain(phone, purpose, null, ip);
    }

    // password_reset: цепочка привязывается к КОНКРЕТНОМУ аккаунту, а не только к
    // строке номера — иначе пропуск, выданный на номер, который его владелец успел
    // освободить, сбросил бы пароль новому владельцу этого номера.
    const user = await this.db.user.findUnique({ where: { phone }, select: { id: true, deletedAt: true } });
    const alive = user && !user.deletedAt ? user : null;
    return this.startChain(phone, purpose, alive?.id ?? null, ip, { simulate: !alive });
  }

  /**
   * Step-up запуск (залогинен): password_change | phone_change_old — код уходит на
   * СОБСТВЕННЫЙ номер аккаунта (телефон из БД, не из body!); phone_change_new — на
   * НОВЫЙ номер из body (проверив, что он свободен).
   *
   * Пароль проверяется ЗДЕСЬ, до отправки: иначе «неверный текущий пароль» всплывал
   * бы уже после сожжённой SMS и введённого кода, а угнанный access-токен работал бы
   * кнопкой SMS-спама на номер владельца.
   */
  async startStepUp(
    userId: string,
    purpose: 'password_change' | 'phone_change_old' | 'phone_change_new',
    password: string,
    newPhone: string | undefined,
    ip?: string,
  ): Promise<VerifyStartResponse> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { phone: true, password: true, deletedAt: true } });
    if (!user || user.deletedAt) throw new UnauthorizedException('Пользователь не найден');
    if (!(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Неверный пароль');
    }

    let phone = user.phone;
    if (purpose === 'phone_change_new') {
      if (!newPhone) throw new BadRequestException('Укажите новый номер телефона');
      if (newPhone === user.phone) throw new BadRequestException('Это ваш текущий номер');
      const taken = await this.db.user.findUnique({ where: { phone: newPhone }, select: { id: true } });
      if (taken) throw new ConflictException('Этот номер уже привязан к другому аккаунту');
      phone = newPhone;
    }
    return this.startChain(phone, purpose, userId, ip);
  }

  /**
   * Личность гостя по внешней ссылке (core/share-links). ВЫЗЫВАЕТСЯ ТОЛЬКО гостевым
   * сервисом движка ссылок, который уже проверил: ссылка жива, тумблер подтверждения
   * включён, пароль (если есть) верен. Публичный /verify/start эту цель отвергает —
   * без гейта по ссылке он был бы бесплатной SMS-пушкой на произвольный номер.
   * Аккаунта у гостя нет → цепочка без userId; гео-щит действует (номер выбирает гость).
   */
  async startGuest(phone: string, ip?: string): Promise<VerifyStartResponse> {
    return this.startChain(phone, 'share_link_guest', null, ip);
  }

  private async startChain(
    phone: string,
    purpose: VerifyPurpose,
    userId: string | null,
    ip?: string,
    opts: StartOptions = {},
  ): Promise<VerifyStartResponse> {
    // Гео-щит — только там, где номер выбирает клиент. Для step-up на собственный
    // номер аккаунта щит не нужен (пампинг им не сделать), иначе легаси-аккаунт с
    // не-казахстанским номером навсегда остался бы без смены пароля.
    if (CLIENT_CHOSEN_PURPOSES.has(purpose) && !isKzMobilePhone(phone)) {
      throw new BadRequestException('Пока поддерживаются только казахстанские мобильные номера (+7 7XX XXX XX XX)');
    }

    // Двойной клик / ретрай клиента: проверка кулдауна и вставка строки не атомарны,
    // без замка два параллельных запроса не видят цепочек друг друга и шлют ДВЕ SMS.
    // Замок берём ОТДЕЛЬНО от вызова: ошибка самой отправки не должна выглядеть как
    // «Redis недоступен» и приводить ко второму заходу (то есть ко второй SMS).
    const lockKey = `verify:start:${phone}:${purpose}`;
    let token: string | null = null;
    let lockWorks = true;
    try {
      token = await this.redis.acquireLock(lockKey, 15_000);
    } catch (err) {
      lockWorks = false; // Redis недоступен — идём без замка (кэш не источник отказа)
      this.logger.warn(`Redis-лок ${lockKey} недоступен (${(err as Error).message}) — старт без него`);
    }
    if (lockWorks && !token) {
      throw new HttpException(
        {
          message: `Код уже отправляется. Повторите через ${VERIFY_LIMITS.resendCooldownSec} сек`,
          details: { resendInSec: VERIFY_LIMITS.resendCooldownSec, code: VERIFY_ERROR_CODES.cooldown },
        },
        429,
      );
    }
    try {
      return await this.startChainLocked(phone, purpose, userId, ip, opts);
    } finally {
      if (token) await this.redis.releaseLock(lockKey, token).catch(() => undefined);
    }
  }

  private async startChainLocked(
    phone: string,
    purpose: VerifyPurpose,
    userId: string | null,
    ip: string | undefined,
    opts: StartOptions,
  ): Promise<VerifyStartResponse> {
    const isTest = this.testPhones.has(phone);
    const simulate = !!opts.simulate;
    const now = new Date();

    // Живая цепочка → это ресенд (кулдаун + потолок отправок на цепочку).
    const active = await this.db.verifyChallenge.findFirst({
      where: {
        phone,
        purpose,
        consumedAt: null,
        verifiedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: VERIFY_LIMITS.maxAttempts },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (active && !isTest) {
      const cooldownSec = active.sendCount >= 2 ? VERIFY_LIMITS.resendCooldownNextSec : VERIFY_LIMITS.resendCooldownSec;
      const nextAllowedAt = active.lastSentAt.getTime() + cooldownSec * 1000;
      if (nextAllowedAt > now.getTime()) {
        const waitSec = Math.ceil((nextAllowedAt - now.getTime()) / 1000);
        // challengeId НАРУЖУ НЕ ОТДАЁМ: он давал бы всякому, кто знает номер, id чужой
        // живой цепочки — а с ним пятью неверными check её код можно сжечь. Клиент,
        // который цепочку начинал, помнит её id сам (sessionStorage).
        throw new HttpException(
          {
            message: `Код уже отправлен. Повторная отправка через ${waitSec} сек`,
            details: { resendInSec: waitSec, code: VERIFY_ERROR_CODES.cooldown },
          },
          429,
        );
      }
      if (active.sendCount >= VERIFY_LIMITS.maxSendsPerChain) {
        throw new HttpException(
          {
            message: 'Слишком много отправок этого кода. Подождите 10 минут и запросите новый',
            details: {
              resendInSec: Math.ceil((active.expiresAt.getTime() - now.getTime()) / 1000),
              code: VERIFY_ERROR_CODES.cooldown,
            },
          },
          429,
        );
      }
    }

    if (!isTest) await this.enforceSendLimits(phone, ip);

    // Код: фиксированный из тест-карты, недостижимый у имитации, иначе криптослучайный.
    const code = isTest
      ? this.testPhones.get(phone)!.padStart(VERIFY_LIMITS.codeLength, '0').slice(-VERIFY_LIMITS.codeLength)
      : randomInt(0, 10 ** VERIFY_LIMITS.codeLength)
          .toString()
          .padStart(VERIFY_LIMITS.codeLength, '0');

    // SMS — ДО записи в БД: упавший провайдер не должен оставлять цепочку-призрак,
    // сжигающую кулдаун (пользователь тут же жмёт «ещё раз»).
    const delivery: Delivery = isTest ? 'test_map' : simulate ? 'simulated' : 'sms';
    let providerMessageId: string | null = null;
    if (delivery === 'sms') {
      const sent = await this.sms.send(phone, buildOtpSmsText(code, process.env.VERIFY_SMS_ORIGIN_DOMAIN || undefined));
      if (!sent.ok) {
        this.logger.error(`SMS не отправлена (${this.sms.driver.name}): ${sent.error}`);
        throw new ServiceUnavailableException('Не удалось отправить SMS. Попробуйте ещё раз через минуту');
      }
      providerMessageId = sent.providerMessageId ?? null;
      // Глобальный бюджет тратится по ФАКТУ отправки (упавший провайдер не должен
      // съедать стоп-кран), поэтому инкремент здесь, а проверка — в enforceSendLimits.
      await this.bumpGlobalBudget();
    } else if (simulate) {
      // Мгновенный ответ сам по себе выдавал бы «аккаунта нет» — имитируем поход к шлюзу.
      await this.sleep(
        randomInt(VERIFY_LIMITS.simulatedSendDelayMinMs, VERIFY_LIMITS.simulatedSendDelayMaxMs + 1),
      );
    }

    const expiresAt = new Date(now.getTime() + VERIFY_LIMITS.codeTtlMin * 60_000);
    let challengeId: string;
    if (active) {
      // Ресенд: НОВЫЙ код в ту же цепочку (attempts сохраняются), TTL перезаводится.
      await this.db.verifyChallenge.update({
        where: { id: active.id },
        data: {
          codeHash: this.hashCode(phone, purpose, code),
          sendCount: { increment: 1 },
          lastSentAt: now,
          expiresAt,
          providerMessageId,
          delivery,
        },
      });
      challengeId = active.id;
    } else {
      const row = await this.db.verifyChallenge.create({
        data: {
          phone,
          purpose,
          codeHash: this.hashCode(phone, purpose, code),
          expiresAt,
          requestIp: ip ?? null,
          userId,
          providerMessageId,
          delivery,
        },
      });
      challengeId = row.id;
    }

    // Dev-обвязка: код доступен dev-ручке /verify/dev/last-code (только development/test —
    // фронт и verify-скрипты не парсят логи). В production ветка мертва. Имитацию сюда
    // НЕ кладём: у неё кода «нет» по определению, и verify-скрипт проверяет именно это.
    if (this.isDevEnv && !simulate) {
      await this.redis.set(`verify:devcode:${challengeId}`, code, VERIFY_LIMITS.codeTtlMin * 60).catch(() => undefined);
    }

    const nextResend = active && active.sendCount + 1 >= 2 ? VERIFY_LIMITS.resendCooldownNextSec : VERIFY_LIMITS.resendCooldownSec;
    return {
      challengeId,
      resendInSec: isTest ? 0 : nextResend,
      ttlSec: VERIFY_LIMITS.codeTtlMin * 60,
      phoneMasked: maskPhone(phone),
      purpose,
    };
  }

  // ------------------------------------------------------------------
  // Проверка кода → одноразовый пропуск
  // ------------------------------------------------------------------

  async check(challengeId: string, code: string, ip?: string): Promise<VerifyCheckResponse> {
    await this.enforceCheckLimit(ip);

    const ch = await this.db.verifyChallenge.findUnique({ where: { id: challengeId } });
    // Единое сообщение для «нет такой цепочки» и истёкших.
    if (!ch || ch.consumedAt) throw this.chainDead('Код неверен или истёк. Запросите новый');
    if (ch.verifiedAt) throw this.chainDead('Код уже подтверждён');
    if (ch.expiresAt.getTime() <= Date.now()) throw this.chainDead('Код истёк. Запросите новый');
    if (ch.attempts >= VERIFY_LIMITS.maxAttempts) {
      throw this.chainDead('Слишком много неверных попыток. Запросите новый код');
    }

    const expected = Buffer.from(ch.codeHash, 'hex');
    const actual = Buffer.from(this.hashCode(ch.phone, ch.purpose as VerifyPurpose, code), 'hex');
    const match = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!match) {
      // Гвард attempts<max закрывает гонку параллельных промахов на потолке.
      await this.db.verifyChallenge.updateMany({
        where: { id: challengeId, attempts: { lt: VERIFY_LIMITS.maxAttempts }, verifiedAt: null },
        data: { attempts: { increment: 1 } },
      });
      const fresh = await this.db.verifyChallenge.findUnique({ where: { id: challengeId }, select: { attempts: true } });
      const left = Math.max(0, VERIFY_LIMITS.maxAttempts - (fresh?.attempts ?? VERIFY_LIMITS.maxAttempts));
      throw new BadRequestException({
        message: left > 0 ? `Неверный код. Осталось попыток: ${left}` : 'Слишком много неверных попыток. Запросите новый код',
        details: { attemptsLeft: left, code: left > 0 ? VERIFY_ERROR_CODES.codeWrong : VERIFY_ERROR_CODES.chainDead },
      });
    }

    // Гонка двух верных check: verifiedAt ставит ровно один.
    const verifyToken = randomBytes(32).toString('hex');
    const { count } = await this.db.verifyChallenge.updateMany({
      where: { id: challengeId, verifiedAt: null, consumedAt: null },
      data: { verifiedAt: new Date(), verifyTokenHash: this.hashToken(verifyToken) },
    });
    if (count === 0) throw this.chainDead('Код уже подтверждён');
    return { verifyToken };
  }

  // ------------------------------------------------------------------
  // Гашение пропуска потребителем (в ЕГО транзакции)
  // ------------------------------------------------------------------

  /**
   * Одноразовое гашение verifyToken. Вызывается В ТРАНЗАКЦИИ целевого действия:
   * откат транзакции = пропуск не потрачен. Возвращает phone цепочки (истина о том,
   * КАКОЙ номер был подтверждён — потребитель не верит телефону из body) и userId
   * (аккаунт, для которого цепочка заводилась; у register — null, юзера ещё нет).
   */
  async consume(
    tx: Prisma.TransactionClient,
    opts: { verifyToken: string; purpose: VerifyPurpose; expectedUserId?: string; expectedPhone?: string },
  ): Promise<{ phone: string; userId: string | null }> {
    const tokenHash = this.hashToken(opts.verifyToken);
    const ch = await tx.verifyChallenge.findUnique({ where: { verifyTokenHash: tokenHash } });
    const fail = () =>
      new BadRequestException({
        message: 'Подтверждение недействительно или устарело. Запросите код заново',
        details: { code: VERIFY_ERROR_CODES.tokenStale },
      });

    if (!ch || !ch.verifiedAt || ch.consumedAt) throw fail();
    if (ch.purpose !== opts.purpose) throw fail();
    if (ch.verifiedAt.getTime() + VERIFY_LIMITS.verifyTokenTtlMin * 60_000 < Date.now()) throw fail();
    if (opts.expectedUserId && ch.userId !== opts.expectedUserId) throw fail();
    if (opts.expectedPhone && ch.phone !== opts.expectedPhone) throw fail();

    const { count } = await tx.verifyChallenge.updateMany({
      where: { id: ch.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) throw fail(); // параллельное гашение выиграл другой
    return { phone: ch.phone, userId: ch.userId };
  }

  // ------------------------------------------------------------------
  // Dev-обвязка (verify-скрипты и ручная проверка фронта без SMS)
  // ------------------------------------------------------------------

  /** Общий предикат платформы (shared/config/env.validation) — держим ОДНУ реализацию. */
  get isDevEnv(): boolean {
    return isDevEnv();
  }

  async devLastCode(challengeId: string): Promise<{ code: string | null }> {
    const code = await this.redis.get(`verify:devcode:${challengeId}`);
    return { code };
  }

  // ------------------------------------------------------------------
  // Лимиты
  // ------------------------------------------------------------------

  /** Номерные потолки — в БД (переживают рестарт). */
  private async enforceSendLimits(phone: string, ip?: string) {
    const hourAgo = new Date(Date.now() - 3_600_000);
    const dayAgo = new Date(Date.now() - 86_400_000);
    // Окно — по времени ПОСЛЕДНЕЙ отправки (или создания): цепочка живёт ресендами до
    // ~45 минут, и счёт по одному created_at терял её свежие отправки. Цепочка,
    // задевшая окно, засчитывается целиком — перебор в СТОРОНУ строгости, что для
    // анти-абьюз-потолка правильно.
    const window = (from: Date) => ({
      phone,
      OR: [{ createdAt: { gt: from } }, { lastSentAt: { gt: from } }],
    });
    const [hour, day] = await Promise.all([
      this.db.verifyChallenge.aggregate({ _sum: { sendCount: true }, where: window(hourAgo) }),
      this.db.verifyChallenge.aggregate({ _sum: { sendCount: true }, where: window(dayAgo) }),
    ]);
    if ((hour._sum.sendCount ?? 0) >= VERIFY_LIMITS.phoneHourlyMax) {
      throw new HttpException({ message: 'Слишком много SMS на этот номер. Попробуйте через час', details: { code: VERIFY_ERROR_CODES.cooldown } }, 429);
    }
    if ((day._sum.sendCount ?? 0) >= VERIFY_LIMITS.phoneDailyMax) {
      throw new HttpException({ message: 'Дневной лимит SMS на этот номер исчерпан. Попробуйте завтра', details: { code: VERIFY_ERROR_CODES.cooldown } }, 429);
    }

    // Redis-эшелоны — best-effort (упал → warn и пропуск: номерные БД-потолки держат).
    try {
      // IP-эшелон в dev/test выключен — как троттлер платформы (secure-by-default
      // наоборот): иначе повторный локальный прогон verify-otp.cjs в том же часу
      // упирается в потолок стартов и падает не по делу.
      if (ip && !this.isDevEnv) {
        const ipCount = await this.slidingCount(`verify:ip:${ip}:start`, 3600, true);
        if (ipCount > VERIFY_LIMITS.ipStartHourlyMax) {
          throw new HttpException({ message: 'Слишком много запросов. Попробуйте позже' }, 429);
        }
      }
      const budget = this.hourlyBudget();
      const global = await this.slidingCount('verify:global', 3600, false);
      if (global >= budget) {
        this.logger.error(
          `🚨 Глобальный SMS-бюджет исчерпан (${global}/${budget} за час) — возможен SMS-пампинг или инцидент. Отправка остановлена.`,
        );
        throw new ServiceUnavailableException('Отправка SMS временно недоступна. Попробуйте позже');
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`Redis-лимиты недоступны (${(err as Error).message}) — пропускаю IP/глобальный эшелон`);
    }
  }

  private async enforceCheckLimit(ip?: string) {
    if (!ip || this.isDevEnv) return;
    try {
      const n = await this.slidingCount(`verify:ip:${ip}:check`, 300, true);
      if (n > VERIFY_LIMITS.ipCheckPer5MinMax) {
        throw new HttpException({ message: 'Слишком много попыток. Подождите 5 минут' }, 429);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`Redis-лимит проверок недоступен: ${(err as Error).message}`);
    }
  }

  private hourlyBudget(): number {
    const raw = Number(process.env.VERIFY_SMS_HOURLY_BUDGET);
    return Number.isFinite(raw) && raw > 0 ? raw : VERIFY_LIMITS.globalHourlyBudgetDefault;
  }

  private async bumpGlobalBudget() {
    try {
      await this.slidingCount('verify:global', 3600, true);
    } catch (err) {
      this.logger.warn(`Не удалось учесть SMS в бюджете: ${(err as Error).message}`);
    }
  }

  /**
   * Скользящее окно на двух корзинах (модель Cloudflare rate limiting): фиксированное
   * окно INCR+EXPIRE обнуляется на границе часа — злоумышленнику достаточно дождаться
   * :00, чтобы получить двойной лимит. Здесь предыдущая корзина учитывается с весом
   * оставшейся от неё доли окна.
   */
  private async slidingCount(prefix: string, windowSec: number, increment: boolean): Promise<number> {
    const client = this.redis.getClient();
    const nowSec = Date.now() / 1000;
    const bucket = Math.floor(nowSec / windowSec);
    const elapsed = (nowSec % windowSec) / windowSec; // 0..1 — сколько текущей корзины прошло
    const curKey = `${prefix}:${bucket}`;
    const prevKey = `${prefix}:${bucket - 1}`;

    let current: number;
    if (increment) {
      const [[, incr]] = (await client
        .multi()
        .incr(curKey)
        .expire(curKey, windowSec * 2)
        .exec()) as Array<[Error | null, unknown]>;
      current = Number(incr) || 0;
    } else {
      current = Number(await client.get(curKey)) || 0;
    }
    const previous = Number(await client.get(prevKey)) || 0;
    return current + previous * (1 - elapsed);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private chainDead(message: string): BadRequestException {
    return new BadRequestException({ message, details: { code: VERIFY_ERROR_CODES.chainDead } });
  }

  // ------------------------------------------------------------------
  // Криптография
  // ------------------------------------------------------------------

  /** HMAC c номером и целью в контексте: код нельзя «переставить» на другой номер/цель. */
  private hashCode(phone: string, purpose: VerifyPurpose | string, code: string): string {
    return createHmac('sha256', `verify:${process.env.JWT_SECRET}`).update(`${phone}|${purpose}|${code}`).digest('hex');
  }

  /** Токен высокоэнтропийный (32 байта CSPRNG) — детерминированный SHA-256 (прецедент refresh-токенов). */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
