import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { badRequest, conflict, forbidden, tooMany, unauthorized } from '../../shared/errors/api-error';
import {
  AUDIT_ERROR_CODES,
  AUDIT_LIMITS,
  CONSENT_AGE,
  CONSENT_ERROR_CODES,
  KEYS_LIMITS,
  ageOnDate,
  consentSelectionSchema,
  platformTodayIso,
  type AuthFailReason,
  type ConsentSelectionInput,
  type VerifyStartResponse, uuidv7 } from '@superapp/shared';
import { ConsentsService } from '../consents/consents.service';
import { ConsentsActionsService } from '../consents/consents.actions.service';
import { KeysSigningService } from '../keys/keys.signing.service';
import { legacySecret } from '../keys/keys.legacy';
import { parseDurationSec } from '../keys/keys.jwt';
// Нативный bcrypt (libuv threadpool): bcryptjs считал cost-12 хэш НА event-loop'е
// (~0.5–1.5с CPU) — десяток одновременных логинов душил все запросы инстанса.
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import { PASSWORD_BCRYPT_ROUNDS, comparePasswordConstantTime } from '../../shared/utils/password-timing';
import { AuditService, type AuditActorInput } from '../audit/audit.service';
import { AuditSessionsService, type LoginDevice, type SessionContextFields } from '../audit/audit.sessions.service';
import { AuditLoginGuard, type LoginSubject } from '../audit/audit.login-guard';
import { AuditAccountService } from '../audit/audit.account.service';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VerifyService } from '../verify/verify.service';
import { JobsService } from '../jobs/jobs.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { USER_PHONE_INVITATIONS_JOB } from '../users/user-jobs';
import type { AuthTokens } from '@superapp/shared';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { isReservedPersonName } from '@superapp/i18n';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private db: DatabaseService,
    private signing: KeysSigningService,
    private redis: RedisService,
    private events: EventBusService,
    private notifications: NotificationsService,
    private verify: VerifyService,
    private jobs: JobsService,
    private wsContext: WorkspaceContextService,
    private entitlements: EntitlementsService,
    private analytics: AnalyticsService,
    private consents: ConsentsService,
    private pdActions: ConsentsActionsService,
    private audit: AuditService,
    private sessions: AuditSessionsService,
    private loginGuard: AuditLoginGuard,
    private account: AuditAccountService,
  ) {}

  async register(data: {
    phone: string;
    password: string;
    firstName: string;
    lastName?: string;
    dateOfBirth: string; // ISO YYYY-MM-DD — обязательна (возраст ≥ 16)
    verifyToken?: string; // одноразовый пропуск движка подтверждений (purpose=register)
    /** Только для сред без SMS-подтверждения; при `verifyToken` игнорируется — правда в SMS-цепочке */
    consents?: ConsentSelectionInput;
  }, deviceInfo?: string | null, evidence: { ip?: string | null; userAgent?: string | null } = {}): Promise<AuthTokens> {
    // Secure-by-default (движок core/verify): в production аккаунт без подтверждённого
    // SMS-кодом номера создать нельзя — иначе возвращается дыра «занял чужой номер —
    // получил его приглашения». В development/test токен опционален (seed/verify-скрипты).
    if (this.verify.required && !data.verifyToken) {
      throw badRequest('auth.verifyRequired');
    }

    // Возраст: регистрация с 16 лет (ГК РК ст. 22 + оговорка оферты о согласии представителя).
    // «Сегодня» — в поясе платформы: по UTC до 05:00 Алматы ещё вчера, и день рождения сдвигался бы.
    const age = ageOnDate(data.dateOfBirth, platformTodayIso());
    if (!Number.isFinite(age) || age < CONSENT_AGE.minRegistration) {
      throw forbidden(CONSENT_ERROR_CODES.minorNotAllowed, { age: CONSENT_AGE.minRegistration });
    }

    // Имя-метка «удалённый пользователь» — маркер томбстоуна (core/lifecycle): живому не взять
    if (isReservedPersonName(data.firstName)) throw badRequest('account.nameReserved');

    // Check if phone already exists
    const existing = await this.db.user.findUnique({
      where: { phone: data.phone },
    });

    if (existing) {
      if (existing.deletionScheduledAt && !existing.deletedAt) {
        throw conflict('auth.phoneOnDeletedAccount');
      }
      throw conflict('auth.phoneTaken');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, PASSWORD_BCRYPT_ROUNDS);

    // Create user + system role + trial subscription + first session in one transaction
    let consentsAfterCommit: (() => Promise<void>) | null = null;
    const ctx = this.sessions.requestContext;
    const { tokens } = await this.db.$transaction(async (tx) => {
      // Гашение пропуска — В ТРАНЗАКЦИИ создания (откат = пропуск не потрачен).
      // expectedPhone гарантирует: подтверждён именно ТОТ номер, на который регистрируемся.
      let chain: Awaited<ReturnType<VerifyService['consume']>> | null = null;
      if (data.verifyToken) {
        chain = await this.verify.consume(tx, {
          verifyToken: data.verifyToken,
          purpose: 'register',
          expectedPhone: data.phone,
        });
      }
      // Что человек принял. С SMS-цепочкой — ТОЛЬКО её контекст (принято ДО отправки кода; тело
      // шага 3 не читается: иначе согласие можно было бы «дорисовать» позже). Без цепочки
      // (development/test) — тело запроса.
      const parsedCtx = chain ? consentSelectionSchema.safeParse(chain.context) : null;
      const selection = chain ? (parsedCtx?.success ? parsedCtx.data : null) : data.consents ?? null;
      if (!selection) throw badRequest(CONSENT_ERROR_CODES.required);

      const newUser = await tx.user.create({
        data: {
          phone: data.phone,
          password: hashedPassword,
          firstName: data.firstName,
          lastName: data.lastName,
          dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
          phoneVerifiedAt: data.verifyToken ? new Date() : null,
          // Язык, на котором человек ЗАПОЛНЯЛ форму (из Accept-Language запроса),
          // а не дефолт колонки: он уже читает продукт на нём, и первое же
          // уведомление должно прийти на том же языке. Незнакомый язык браузера
          // negotiateLocale сводит к казахскому.
          locale: this.wsContext.locale,
        },
      });

      // Assign default system role: "user"
      await tx.userRole.create({
        data: {
          userId: newUser.id,
          role: 'user',
          context: 'system',
          tenantId: null,
        },
      });

      // Пробный период личного тарифа (core/entitlements): 30 дней `personal` в той же
      // транзакции — аккаунт без подписки = free, триал не заводится дважды (уникум).
      await this.entitlements.startTrial(tx, { type: 'user', id: newUser.id });

      // Приглашения, висевшие на этом номере, активирует ДЖОБ, поставленный в
      // ЭТОЙ ЖЕ транзакции (transactional outbox core/jobs) — тот же путь, что
      // при смене номера. Раньше активация делалась двумя await'ами ПОСЛЕ
      // коммита и без подстраховки: любой блип БД/Redis на этом шаге отдавал
      // клиенту 500, хотя пользователь уже создан, — номер занят, повторная
      // регистрация невозможна, а приглашения (включая приглашения в
      // организации) терялись насовсем.
      await this.jobs.enqueue(tx, {
        type: USER_PHONE_INVITATIONS_JOB,
        payload: { userId: newUser.id, phone: newUser.phone },
        uniqueKey: `phone-invites:${newUser.id}:${newUser.phone}`,
      });
      // Записи приёмки — в ЭТОЙ ЖЕ транзакции, что гашение пропуска и создание аккаунта: аккаунта
      // без согласия не существует ни мгновения. По записи на документ, общий `bundleKey`;
      // обязательные документы пакета сверяет движок (`requireBundle`), рассылки — по выбору.
      const accepted = await this.consents.accept(tx, {
        subject: { type: 'user', id: newUser.id },
        actorUserId: newUser.id,
        actorRole: 'self',
        versionIds: selection.versionIds,
        locale: selection.locale,
        channel: selection.channel,
        bundleKey: 'registration',
        requireBundle: 'registration',
        evidence: { ip: evidence.ip ?? null, userAgent: evidence.userAgent ?? null, verifyChallengeId: chain?.challengeId ?? null },
        acceptedAt: chain?.startedAt,
        // Квитанция новичку не шлётся: первое, что он видит, — не уведомление о собственной галочке
        notify: false,
      });
      consentsAfterCommit = accepted.afterCommit;
      // Учёт действий с ПДн: код регистрации ушёл SMS-шлюзу ещё до аккаунта — запись ставится сейчас
      if (chain?.smsSent) {
        await this.pdActions.record(tx, { subjectId: newUser.id, recipient: 'kazinfoteh', fields: ['phone'], purpose: 'otp_sms', refType: 'verify_challenge', refId: chain.challengeId });
      }

      // Аналитика: факт регистрации — в той же транзакции (откат = события нет)
      await this.analytics.track(tx, 'auth.user.registered', { verified: !!data.verifyToken }, { userId: newUser.id, workspaceId: null });

      // Журнал безопасности и первая сессия — той же транзакцией: устройство регистрации
      // доверено сразу (cooling не у него), «новым устройством» оно не считается
      await this.audit.record(tx, { key: 'account.registered', subjectUserId: newUser.id, actor: { kind: 'user', id: newUser.id }, details: {} });
      const device = await this.sessions.deviceForLogin(tx, newUser.id, ctx, { registration: true });
      return this.signIn(tx, { userId: newUser.id, phone: newUser.phone, role: 'user', epoch: newUser.tokenEpoch, deviceInfo, device, method: 'register', newCountry: null, quiet: true });
    });
    // Кэши шлюза согласий — после коммита (сброс внутри транзакции гонится с чтением)
    await (consentsAfterCommit as (() => Promise<void>) | null)?.().catch(() => undefined);
    return tokens;
  }

  /**
   * Вход паролем. Защита по АККАУНТУ (core/audit): блокировка после серии неудач, неизвестный
   * номер отвечает так же и за то же время (bcrypt всегда — нет timing-оракула), каждая неудача —
   * событие журнала (fail-closed). Удачный вход — одна транзакция: восстановление из окна удаления,
   * устройство, сессия, события входа / нового устройства / новой страны, уведомления.
   */
  async login(phone: string, password: string, deviceInfo?: string | null): Promise<AuthTokens & { restored: boolean }> {
    const user = await this.db.user.findUnique({
      where: { phone },
      include: {
        roles: {
          where: { context: 'system', isActive: true },
          select: { role: true },
        },
      },
    });
    // Бот (core/keys) — теневой пользователь: входа паролем у него нет никогда
    const eligible = !!user && !user.deletedAt && user.kind === 'person';
    const subject: LoginSubject = { userId: eligible ? user!.id : null, phoneHmac: await this.loginGuard.phoneHmac(phone) };
    const lockedUntil = await this.loginGuard.lockedUntil(subject, eligible ? user!.loginLockedUntil : null);
    // Сравнение — ВСЕГДА (и при блокировке): стоимость ответа не зависит от существования номера
    const passwordOk = await comparePasswordConstantTime(password, eligible ? user!.password : null);
    if (lockedUntil) await this.loginGuard.rejectLocked(subject, lockedUntil);

    if (!eligible || !passwordOk) {
      const reason: AuthFailReason = !user || user.deletedAt ? 'unknown_account' : user.kind !== 'person' ? 'not_allowed' : 'wrong_password';
      const lockedNow = await this.loginGuard.onFailure(subject, reason);
      // Попытка уже посчитана onFailure — только ответ 429 (без второго счёта в итог блокировки)
      if (lockedNow) this.loginGuard.lockedResponse(lockedNow);
      if (user?.deletedAt) throw unauthorized('auth.accountDeleted');
      throw unauthorized('auth.badCredentials');
    }
    const person = user!;
    // Заморожен (core/audit): отказ — только ПОСЛЕ верного пароля (ответ не оракул чужого состояния)
    if (person.securityFrozenAt) {
      await this.audit.record(null, { key: 'auth.login.failed', subjectUserId: person.id, outcome: 'denied', reasonCode: 'frozen', details: {} });
      throw forbidden('auth.frozen', undefined, { code: AUDIT_ERROR_CODES.accountFrozen });
    }

    const systemRole = this.getHighestSystemRole(person.roles.map((r) => r.role));
    const ctx = this.sessions.requestContext;
    const quiet = Date.now() - person.createdAt.getTime() < AUDIT_LIMITS.newAccountQuietDays * 86_400_000;
    const { tokens, restored } = await this.db.$transaction(async (tx) => {
      // Вход в окне удаления отменяет удаление. Условие deletedAt=null: аккаунт, который крон
      // анонимизировал между чтением и этой строкой, не «восстанавливается» и токенов не получает.
      let restoredNow = false;
      if (person.deletionScheduledAt) {
        const { count } = await tx.user.updateMany({ where: { id: person.id, deletedAt: null }, data: { deletionScheduledAt: null } });
        if (count === 0) throw unauthorized('auth.accountDeleted');
        restoredNow = true;
        await this.audit.record(tx, { key: 'account.deletion_cancelled', subjectUserId: person.id, actor: { kind: 'user', id: person.id }, details: {} });
      }
      await this.loginGuard.onSuccessTx(tx, person.id);
      const device = await this.sessions.deviceForLogin(tx, person.id, ctx);
      const novelty = await this.sessions.countryNovelty(tx, person.id, ctx?.country ?? null);
      const signed = await this.signIn(tx, { userId: person.id, phone: person.phone, role: systemRole, epoch: person.tokenEpoch, deviceInfo, device, method: 'password', newCountry: novelty, quiet });
      return { tokens: signed.tokens, restored: restoredNow };
    });
    if (restored) await this.redis.invalidateUserProfile(person.id);
    return { ...tokens, restored };
  }

  /**
   * Выдать сессию входа В ТРАНЗАКЦИИ входа: новое семейство (контекст устройства, сети, cooling),
   * события `auth.login.success` и, если есть, `auth.session.new_device|new_country` (их
   * уведомления шлёт паспорт реестра в той же транзакции), аналитика.
   */
  private async signIn(
    tx: Prisma.TransactionClient,
    a: {
      userId: string;
      phone: string;
      role: string;
      epoch: number;
      deviceInfo?: string | null;
      device: LoginDevice;
      method: 'password' | 'register' | 'unfreeze' | 'reset';
      newCountry: { newCountry: boolean; previousCountry: string | null } | null;
      quiet: boolean;
    },
  ): Promise<{ tokens: AuthTokens; sessionId: string; familyId: string }> {
    const ctx = this.sessions.requestContext;
    const familyId = uuidv7();
    const minted = await this.mintSession(tx, a.userId, a.phone, a.role, a.epoch, a.deviceInfo, familyId, this.sessions.newFamilyFields(ctx, a.device));
    const actor: AuditActorInput = { kind: 'user', id: a.userId, sessionId: minted.sessionId, familyId };
    const target = { type: 'session', id: familyId };
    const newCountry = !!a.newCountry?.newCountry;
    await this.audit.record(tx, { key: 'auth.login.success', subjectUserId: a.userId, actor, target, details: { method: a.method, newDevice: a.device.isNew, newCountry } });
    if (a.device.isNew) {
      await this.audit.record(tx, {
        key: 'auth.session.new_device',
        subjectUserId: a.userId,
        actor,
        target,
        details: { deviceClass: a.device.deviceClass, quiet: a.quiet },
        ...(a.device.label ? { notify: { params: { device: a.device.label } } } : {}),
      });
    }
    if (newCountry) {
      await this.audit.record(tx, { key: 'auth.session.new_country', subjectUserId: a.userId, actor, target, details: a.newCountry?.previousCountry ? { previousCountry: a.newCountry.previousCountry } : {} });
    }
    if (a.method !== 'register') await this.analytics.track(tx, 'auth.user.logged_in', {}, { userId: a.userId, workspaceId: null });
    return { tokens: minted.tokens, sessionId: minted.sessionId, familyId };
  }

  /**
   * Завершение «Забыли пароль?» (движок core/verify, purpose=password_reset):
   * verifyToken доказывает владение номером → смена пароля + отзыв ВСЕХ сессий +
   * уведомление + АВТОВХОД (решение продукта: человек только что подтвердил номер
   * и задал пароль — заставлять вводить его снова через 3 секунды бессмысленно).
   * Аккаунт в грейс-периоде удаления восстанавливается (симметрия с login).
   */
  async resetPassword(
    verifyToken: string,
    newPassword: string,
    deviceInfo?: string | null,
  ): Promise<AuthTokens & { restored: boolean }> {
    const hashedPassword = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_ROUNDS); // CPU — до транзакции
    const ctx = this.sessions.requestContext;

    const { userId, restored, tokens, families } = await this.db.$transaction(async (tx) => {
      // Гашение пропуска в этой же транзакции: откат = пропуск не потрачен.
      const consumed = await this.verify.consume(tx, {
        verifyToken,
        purpose: 'password_reset',
      });
      // Аккаунт берём по id, зафиксированному при ЗАПУСКЕ цепочки, а не по строке
      // номера: иначе пропуск, выданный на номер, который его владелец успел
      // освободить (смена номера / удаление аккаунта), в свои 15 минут жизни сбросил
      // бы пароль НОВОМУ владельцу этого номера. Фолбэк по телефону — для цепочек,
      // заведённых до появления привязки (окно ретеншна, 7 дней).
      const user = consumed.userId
        ? await tx.user.findUnique({
            where: { id: consumed.userId },
            select: { id: true, phone: true, deletedAt: true, deletionScheduledAt: true, securityFrozenAt: true, loginLockedUntil: true, kind: true, createdAt: true },
          })
        : await tx.user.findUnique({
            where: { phone: consumed.phone },
            select: { id: true, phone: true, deletedAt: true, deletionScheduledAt: true, securityFrozenAt: true, loginLockedUntil: true, kind: true, createdAt: true },
          });
      // Нейтральная формулировка (анти-энумерация reset-потока сохраняется).
      // Проверка phone: номер аккаунта не должен был поменяться после выдачи пропуска.
      if (!user || user.deletedAt || user.kind !== 'person' || user.phone !== consumed.phone) {
        throw badRequest('auth.verifyStale');
      }
      // Заморозку сброс по SMS НЕ снимает: её и ставят против угона SIM — владелец угнанной
      // симки иначе снял бы её сам. Разморозка — старый пароль + SMS или Кабинет.
      if (user.securityFrozenAt) throw forbidden('auth.frozen', undefined, { code: AUDIT_ERROR_CODES.accountFrozen });
      await tx.user.update({
        where: { id: user.id },
        data: { password: hashedPassword, deletionScheduledAt: null },
      });
      // Все сессии — в отставку (мягко: улика и «кто отозвал» остаются): чужие руки со
      // старым паролем/refresh-токенами отрезаны; выданные access-токены — поколением.
      const revoked = await this.sessions.revokeFamilies(tx, user.id, {}, 'reset');
      const bump = await this.account.bumpTokenEpochTx(tx, user.id);
      const unlocked = await this.loginGuard.unlockTx(tx, user.id);
      await this.audit.record(tx, {
        key: 'auth.password.reset_completed',
        subjectUserId: user.id,
        actor: { kind: 'user', id: user.id },
        details: { sessionsRevoked: revoked.count, unlocked },
        evidence: { factor: 'sms', verifyChallengeId: consumed.challengeId },
      });
      await this.analytics.track(tx, 'auth.password.reset', {}, { userId: user.id, workspaceId: null });
      // Автовход — новое семейство той же транзакцией (cooling — по правилу устройства)
      const roles = await tx.userRole.findMany({ where: { userId: user.id, context: 'system', isActive: true }, select: { role: true } });
      const device = await this.sessions.deviceForLogin(tx, user.id, ctx);
      const quiet = Date.now() - user.createdAt.getTime() < AUDIT_LIMITS.newAccountQuietDays * 86_400_000;
      const signed = await this.signIn(tx, { userId: user.id, phone: user.phone, role: this.getHighestSystemRole(roles.map((r) => r.role)), epoch: bump.epoch, deviceInfo, device, method: 'reset', newCountry: null, quiet });
      return { userId: user.id, restored: !!user.deletionScheduledAt, tokens: signed.tokens, families: revoked.families };
    });

    // Кэш поколения, отметки отозванных семейств и живые сокеты — сразу после коммита
    await this.account.afterAccessRevoked(userId, families);
    return { ...tokens, restored };
  }

  /**
   * Ротация refresh-токена с обнаружением повторного предъявления (RFC 9700 §2.2.2).
   * Прокрученная строка НЕ удаляется, а помечается `rotatedAt` + `replacedById`: если
   * её токен предъявят снова вне окна grace (сетевой ретрай — 10 с), это утечка —
   * всё семейство сессии отзывается, владельцу уходит `auth.session.reuseDetected`.
   */
  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    // Подпись/срок — до похода в БД: чужая строка не должна стоить запроса
    try {
      await this.signing.verify('product', refreshToken, { typ: 'refresh+jwt', forbidTyp: ['at+jwt'], legacy: { secret: legacySecret(), audienceOptional: true, typOptional: true } });
    } catch {
      throw unauthorized('auth.sessionExpired');
    }
    const tokenHash = this.hashToken(refreshToken);
    const session = await this.db.session.findUnique({
      where: { token: tokenHash },
      include: {
        user: {
          include: {
            roles: {
              where: { context: 'system', isActive: true },
              select: { role: true },
            },
          },
        },
      },
    });

    // Мягко отозванное семейство (выход, «завершить сессию», заморозка) — как истёкшее
    if (!session || session.expiresAt < new Date() || session.revokedAt) {
      throw unauthorized('auth.sessionExpired');
    }

    if (session.rotatedAt) {
      const sinceMs = Date.now() - session.rotatedAt.getTime();
      if (sinceMs > KEYS_LIMITS.refreshReuseGraceSec * 1000) {
        // Повтор вне grace = утечка токена: семейство отозвано целиком, событие CRITICAL и
        // уведомление (паспорт) — ОДНОЙ транзакцией; предъявитель неизвестен — актор аноним
        const revoked = await this.db.$transaction(async (tx) => {
          const r = await this.sessions.revokeFamilies(tx, session.userId, { only: [session.familyId] }, 'reuse');
          await this.audit.record(tx, {
            key: 'auth.session.refresh_reuse',
            subjectUserId: session.userId,
            actor: { kind: 'anonymous' },
            outcome: 'denied',
            reasonCode: 'refresh_reuse',
            target: { type: 'session', id: session.familyId },
            details: { sessions: r.count },
          });
          await this.analytics.track(tx, 'keys.session.reuse_detected', {}, { userId: session.userId, workspaceId: null });
          return r;
        });
        await revoked.afterCommit();
        this.events.emit('auth.sessions.revoked', { userId: session.userId }, 'auth');
        this.logger.warn(`refresh token reuse detected: user ${session.userId}, family ${session.familyId} revoked`);
        throw unauthorized('auth.sessionExpired');
      }
      // Внутри grace: тот же клиент повторил запрос — выдаём ещё одну пару того же семейства
    }

    const systemRole = this.getHighestSystemRole(
      session.user.roles.map((r) => r.role),
    );

    // Контекст семейства (устройство, сеть, страна, клиент, момент входа, подтверждение)
    // наследуется от ротируемой строки — «сессия» человека живёт дольше одной строки.
    const inherited: SessionContextFields = {
      deviceId: session.deviceId,
      uaFamily: session.uaFamily,
      ipNet: session.ipNet,
      country: session.country,
      client: session.client,
      familyCreatedAt: session.familyCreatedAt,
      confirmedAt: session.confirmedAt,
    };
    const minted = await this.db.$transaction(async (tx) => {
      const m = await this.mintSession(tx, session.user.id, session.user.phone, systemRole, session.user.tokenEpoch, session.deviceInfo, session.familyId, inherited);
      // Прокрутка: старая строка остаётся до истечения (её предъявление = сигнал), guard по
      // rotatedAt — гонка двух refresh одним токеном помечает ровно один раз
      await tx.session.updateMany({
        where: { id: session.id, rotatedAt: null },
        data: { rotatedAt: new Date(), replacedById: m.sessionId },
      });
      return m;
    });
    this.sessions.touch(session.userId, session.familyId);
    return minted.tokens;
  }

  /**
   * Выход — всё семейство сессии этого устройства (прокрученные строки включительно), мягко:
   * строки остаются (улика reuse, «вышедшие устройства»). Семейство — по refresh-токену, а если
   * клиент его потерял — по `fam` access-токена.
   */
  async logout(user: JwtPayload, refreshToken: string | undefined) {
    let familyId: string | null = null;
    if (refreshToken) {
      const row = await this.db.session.findFirst({ where: { userId: user.sub, token: this.hashToken(refreshToken) }, select: { familyId: true } });
      familyId = row?.familyId ?? null;
    }
    familyId ??= await this.sessions.currentFamilyOf(user);
    if (!familyId) return;
    const family = familyId;
    const revoked = await this.db.$transaction(async (tx) => {
      const r = await this.sessions.revokeFamilies(tx, user.sub, { only: [family] }, 'self');
      if (r.count) await this.audit.record(tx, { key: 'auth.logout', subjectUserId: user.sub, target: { type: 'session', id: family }, details: {} });
      return r;
    });
    await revoked.afterCommit();
  }

  /**
   * «Выйти на всех других устройствах»: все ДРУГИЕ семейства мягко завершены, поколение токенов
   * вперёд (выданные access-токены гаснут сразу, личные ключи API — тоже: ключ = сессия без
   * срока). Текущая вкладка переживает это прозрачно: её refresh цел, single-flight refresh
   * клиента выдаст токен нового поколения. Cooling-гард — у контроллера.
   */
  async logoutAll(user: JwtPayload) {
    const current = await this.sessions.currentFamilyOf(user);
    const out = await this.db.$transaction(async (tx) => {
      const r = await this.sessions.revokeFamilies(tx, user.sub, { except: current }, 'logout_all');
      await this.account.bumpTokenEpochTx(tx, user.sub);
      await this.audit.record(tx, { key: 'auth.logout_all', subjectUserId: user.sub, details: { sessions: r.count } });
      return r;
    });
    await this.account.afterAccessRevoked(user.sub, out.families);
  }

  // ============================================================
  // Заморозка без входа (core/audit) — публичные ручки `/auth/freeze/*`, `/auth/unfreeze/*`
  // ============================================================

  freezeStart(phone: string, ip?: string): Promise<VerifyStartResponse> {
    return this.verify.startFreeze(phone, ip);
  }

  freezeConfirm(verifyToken: string): Promise<{ frozen: true }> {
    return this.account.freeze(verifyToken);
  }

  unfreezeStart(phone: string, password: string, ip?: string): Promise<VerifyStartResponse> {
    return this.verify.startUnfreeze(phone, password, ip);
  }

  /** Разморозка паролем + SMS → сразу вход (новое семейство той же транзакцией). */
  async unfreezeConfirm(verifyToken: string, deviceInfo?: string | null): Promise<AuthTokens> {
    const ctx = this.sessions.requestContext;
    const { tokens } = await this.db.$transaction(async (tx) => {
      const userId = await this.account.unfreezeTx(tx, verifyToken);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, phone: true, tokenEpoch: true, createdAt: true, roles: { where: { context: 'system', isActive: true }, select: { role: true } } },
      });
      const device = await this.sessions.deviceForLogin(tx, userId, ctx);
      const quiet = Date.now() - user.createdAt.getTime() < AUDIT_LIMITS.newAccountQuietDays * 86_400_000;
      return this.signIn(tx, { userId, phone: user.phone, role: this.getHighestSystemRole(user.roles.map((r) => r.role)), epoch: user.tokenEpoch, deviceInfo, device, method: 'unfreeze', newCountry: null, quiet });
    });
    return tokens;
  }

  private getHighestSystemRole(roles: string[]): string {
    // Priority: admin > moderator > user
    if (roles.includes('admin')) return 'admin';
    if (roles.includes('moderator')) return 'moderator';
    return 'user';
  }

  /**
   * Сама чеканка: access `typ: at+jwt` и refresh `typ: refresh+jwt` — оба EdDSA с `kid`
   * аудитории `product` (core/keys). Идентификатор строки генерируется ЗДЕСЬ и уезжает в payload
   * (`sid`), семейство — `fam` (журнал и cooling узнают «сессию» человека без refresh-токена).
   * `familyId` — семейство refresh-цепочки одного устройства: новый вход = новое семейство,
   * ротация наследует его вместе с контекстом (`fields`). В ТРАНЗАКЦИИ вызывающего.
   */
  private async mintSession(
    tx: Prisma.TransactionClient,
    userId: string,
    phone: string,
    role: string,
    epoch: number,
    deviceInfo: string | null | undefined,
    familyId: string,
    fields: SessionContextFields,
  ): Promise<{ tokens: AuthTokens; sessionId: string }> {
    const sessionId = uuidv7();
    const payload: JwtPayload = { sub: userId, phone, role, epoch, sid: sessionId, fam: familyId };
    const accessTtl = parseDurationSec(process.env.JWT_EXPIRES_IN) ?? 15 * 60;
    const refreshTtl = parseDurationSec(process.env.JWT_REFRESH_EXPIRES_IN) ?? 30 * 86_400;

    const accessToken = await this.signing.sign('product', { ...payload }, { ttlSec: accessTtl, typ: 'at+jwt' });

    // Уникальный jti делает подписанный refresh (и его SHA-256 на unique-колонке
    // session.token) разным даже у двух входов в одну секунду (одинаковый iat).
    const refreshToken = await this.signing.sign('product', { ...payload, jti: randomUUID() }, { ttlSec: refreshTtl, typ: 'refresh+jwt' });

    const tokenHash = this.hashToken(refreshToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + refreshTtl * 1000);

    await tx.session.create({
      data: {
        id: sessionId,
        userId,
        token: tokenHash,
        deviceInfo: deviceInfo ?? null,
        expiresAt,
        familyId,
        lastSeenAt: now,
        ...fields,
      },
    });

    return { tokens: { accessToken, refreshToken, expiresIn: accessTtl }, sessionId };
  }

  /**
   * Deterministic hash for refresh-token lookup. This MUST be deterministic
   * (unlike bcrypt, which embeds a random salt per call) because the token is
   * looked up by equality on the unique `session.token` column. The refresh
   * token is a signed JWT with high entropy, so an unsalted SHA-256 is the
   * correct primitive here — this is NOT a low-entropy password.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
