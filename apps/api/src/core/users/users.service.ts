import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../shared/errors/api-error';
import { DELETED_USER_MARKER, coerceLocale, isReservedPersonName } from '@superapp/i18n';
import { ConsentsService } from '../consents/consents.service';
import { ConsentsActionsService } from '../consents/consents.actions.service';
import { ConsentsGateService } from '../consents/gate/consents-gate.service';
import { SmsOutboundService } from '../verify/sms-outbound.service';
import { AuditService } from '../audit/audit.service';
import { AuditSessionsService } from '../audit/audit.sessions.service';
import { AuditAccountService } from '../audit/audit.account.service';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { I18nService } from '../../shared/i18n/i18n.service';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { authAliveKey } from '../../shared/auth/session-validator.service';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessProjectionService } from '../access/access-projection.service';
import { FilesService } from '../files/files.service';
import { VerifyService } from '../verify/verify.service';
import { JobsService } from '../jobs/jobs.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PlatformAccessService } from '../platform/platform-access.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { USER_PHONE_INVITATIONS_JOB } from './user-jobs';
import { LifecycleErasureService } from '../lifecycle/lifecycle.erasure.service';
import {
  LifecycleCanaryRegistry,
  LifecycleSubjectHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
  type LifecycleSubjectEraseContext,
} from '../lifecycle/lifecycle.purge.registry';
import { ContactsService } from '../../modules/contacts/contacts.service';
import { WorkspacesService } from '../../modules/workspaces/workspaces.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KeysCascadesService } from '../keys/api-keys/keys.cascades.service';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { VisibilityPolicyService } from '../visibility/visibility.policy.service';
import { VisibilityService, markShaped } from '../visibility/visibility.service';
import { VisibilityDiscoverabilityService } from '../visibility/visibility.discoverability.service';
import { USER_CARD_SELECT, UserCardService } from './user-card.service';
import {
  CONSENT_AGE,
  CONSENT_ERROR_CODES,
  LIFECYCLE_ACCOUNT_GRACE_DAYS,
  isUuid,
  ageOnDate,
  maskPhone,
  platformTodayIso,
  type AccountDeletionBlockersDto,
  type AccountDeletionResultDto,
  type ChangePasswordInput,
  type ChangePhoneInput,
  type SocialLinks,
  type UpdateProfileInput,
  type User,
  type UserLookupDto,
  type UserProfile,
  type ContactUserCard,
  type VisibilityPreviewAs,
  type VisibilityPreviewQuery,
} from '@superapp/shared';
import { ChatterService } from '../chatter/chatter.service';

/** Days a deleted account stays recoverable before permanent anonymization. */
// Грейс удаления аккаунта — одна правда с оркестратором стирания (shared, ЗоПД ст. 8 п. 7)
export const ACCOUNT_GRACE_DAYS = LIFECYCLE_ACCOUNT_GRACE_DAYS;

// Джоб активации приглашений: константа общая с регистрацией (см. user-jobs.ts),
// реэкспорт — чтобы прежние импорты из этого файла продолжали работать.
export { USER_PHONE_INVITATIONS_JOB } from './user-jobs';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private events: EventBusService,
    private accessProjection: AccessProjectionService,
    private files: FilesService,
    private verify: VerifyService,
    private jobs: JobsService,
    private jobsRegistry: JobsRegistry,
    private contacts: ContactsService,
    private workspaces: WorkspacesService,
    private notifications: NotificationsService,
    private i18n: I18nService,
    private entitlements: EntitlementsService,
    private platformAccess: PlatformAccessService,
    private analytics: AnalyticsService,
    private keysCascades: KeysCascadesService,
    private keysEnvelope: KeysEnvelopeService,
    private consents: ConsentsService,
    private consentsGate: ConsentsGateService,
    private pdActions: ConsentsActionsService,
    private smsOutbound: SmsOutboundService,
    private audit: AuditService,
    private sessions: AuditSessionsService,
    private account: AuditAccountService,
    private visibilityPolicies: VisibilityPolicyService,
    private visibility: VisibilityService,
    private discoverability: VisibilityDiscoverabilityService,
    private userCards: UserCardService,
    private chatter: ChatterService,
    private erasure: LifecycleErasureService,
    private subjectHooks: LifecycleSubjectHookRegistry,
    private canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(USER_PHONE_INVITATIONS_JOB, (payload) => this.runPhoneInvitationsJob(payload));
    // Корневой шаг стирания человека (оркестратор core/lifecycle): скрыть и стереть ПДн строки
    this.subjectHooks.register('users.account', { erase: (userId, ctx) => this.eraseAccount(userId, ctx) });
    this.canary.register('users.account', (ctx) => this.seedCanary(ctx));
  }

  /**
   * ФОРМА ПРОВОДА `GET /users/me` — аннотация `Promise<UserProfile>` и есть договор с
   * клиентами: она заставляет компилятор удерживать сериализацию (Date → ISO-строка
   * В СЕРВИСЕ), computed `isVerified` и полный набор полей. До 2026-08-07 возврат
   * выводился из Prisma-select, и веб держал свою урезанную копию типа.
   */
  async getProfile(userId: string): Promise<UserProfile> {
    // Кэш профиля несёт ПДн (телефон, ИИН, адрес, номер документа), поэтому лежит в Redis
    // envelope-шифротекстом под KEK САМОГО человека: открытого текста в кэше нет, а заморозка
    // или уничтожение его KEK гасит и кэш — он просто перестаёт открываться (промах → БД).
    const cached = await this.readProfileCache(userId);
    if (cached) return cached;

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        middleName: true,
        dateOfBirth: true,
        avatar: true,
        bio: true,
        city: true,
        email: true,
        maritalStatus: true,
        socialLinks: true,
        phoneVerifiedAt: true,
        kind: true,
        locale: true,
        timezone: true,
        iin: true,
        residentialAddress: true,
        idDocNumber: true,
        idDocIssuedBy: true,
        idDocIssuedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          where: { isActive: true },
          select: {
            role: true,
            context: true,
            tenantId: true,
          },
        },
        _count: {
          select: {
            ownedCircles: true,
            // Только ЖИВЫЕ организации: `GET /workspaces` показывает список с этим же
            // фильтром, и без него счётчик «Пространств» считал деактивированные —
            // человек видел «2 Пространств» над надписью «У вас пока нет организаций».
            workspaceMembers: { where: { workspace: { isActive: true } } },
            contactLinksA: true,
            contactLinksB: true,
          },
        },
      },
    });

    if (!user) {
      throw notFound('auth.userNotFound');
    }

    const { _count, dateOfBirth, phoneVerifiedAt, idDocIssuedAt, ...rest } = user;

    const profile: UserProfile = {
      ...rest,
      // JSON-колонка: единственный узаконенный каст границы (на записи её стережёт strict-Zod).
      socialLinks: rest.socialLinks as SocialLinks | null,
      createdAt: rest.createdAt.toISOString(),
      updatedAt: rest.updatedAt.toISOString(),
      // Наружу — прежний boolean (веб/mobile не меняются); истина в БД — timestamp.
      isVerified: !!phoneVerifiedAt,
      kind: rest.kind === 'bot' ? 'bot' : 'person',
      dateOfBirth: dateOfBirth ? dateOfBirth.toISOString().slice(0, 10) : null,
      idDocIssuedAt: idDocIssuedAt ? idDocIssuedAt.toISOString().slice(0, 10) : null,
      circlesCount: _count.ownedCircles,
      workspacesCount: _count.workspaceMembers,
      contactsCount: _count.contactLinksA + _count.contactLinksB,
    };

    await this.writeProfileCache(userId, profile);

    return profile;
  }

  private profileCacheCtx(userId: string) {
    return { entity: 'user', field: 'profile_cache', ownerType: 'user', ownerId: userId };
  }

  private async readProfileCache(userId: string): Promise<UserProfile | null> {
    try {
      const stored = await this.redis.get(`user:${userId}:profile`);
      if (!stored || !this.keysEnvelope.isEnvelope(stored)) return null; // в т.ч. запись прошлого формата (открытый JSON)
      const dec = await this.keysEnvelope.tryDecrypt({ type: 'user', id: userId }, this.profileCacheCtx(userId), stored);
      return dec.ok ? (JSON.parse(dec.value) as UserProfile) : null;
    } catch {
      return null;
    }
  }

  /** Кэш на 5 минут; KEK недоступен (заморожен/уничтожен) — не кэшируем вовсе: профиль без ПДн не залипает. */
  private async writeProfileCache(userId: string, profile: UserProfile): Promise<void> {
    try {
      const stored = await this.keysEnvelope.encrypt({ type: 'user', id: userId }, this.profileCacheCtx(userId), JSON.stringify(profile));
      await this.redis.set(`user:${userId}:profile`, stored, 300);
    } catch {
      /* best-effort: без кэша профиль читается из БД */
    }
  }

  /** Ответ `PATCH /users/me` — урезанный профиль (веб его не читает, но контракт стоит). */
  async updateProfile(
    userId: string,
    data: UpdateProfileInput,
  ): Promise<Omit<User, 'isVerified' | 'createdAt' | 'updatedAt'>> {
    const { dateOfBirth, socialLinks, ...rest } = data;
    // Имя-метка «удалённый пользователь» — маркер томбстоуна стёртого человека: живому его взять
    // нельзя ни на одном языке, иначе он выдавал бы себя за стёртого (core/lifecycle)
    if (isReservedPersonName(rest.firstName)) throw badRequest('account.nameReserved');
    // Аватар хранится ССЫЛКОЙ (не FileLink) → при замене прибираем прежний файл сами,
    // иначе каждая смена аватара навсегда копит квоту (публичные файлы крон не свипает).
    const prevAvatar =
      rest.avatar !== undefined
        ? (await this.db.user.findUnique({ where: { id: userId }, select: { avatar: true } }))?.avatar
        : undefined;

    // Дата рождения — опора возрастных правил (регистрация с 16, реальные деньги с 18): её нельзя
    // ни стереть, ни сдвинуть ниже порога регистрации. «Сегодня» — в поясе платформы.
    if (dateOfBirth !== undefined) {
      if (!dateOfBirth) throw badRequest('auth.dateOfBirthRequired');
      const age = ageOnDate(dateOfBirth, platformTodayIso());
      if (!Number.isFinite(age) || age < CONSENT_AGE.minRegistration) throw forbidden(CONSENT_ERROR_CODES.minorNotAllowed, { age: CONSENT_AGE.minRegistration });
    }

    const user = await this.db.user.update({
      where: { id: userId },
      data: {
        ...rest,
        ...(dateOfBirth !== undefined && {
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        }),
        ...(socialLinks !== undefined && {
          socialLinks: socialLinks as any,
        }),
      },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        middleName: true,
        dateOfBirth: true,
        avatar: true,
        bio: true,
        city: true,
        email: true,
        maritalStatus: true,
        socialLinks: true,
        kind: true,
        locale: true,
        timezone: true,
        iin: true,
        residentialAddress: true,
        idDocNumber: true,
        idDocIssuedBy: true,
        idDocIssuedAt: true,
      },
    });

    // Invalidate cache
    await this.redis.invalidateUserProfile(userId);

    if (rest.avatar !== undefined && prevAvatar !== user.avatar) {
      await this.files
        .reapReplacedPublicFile('user', userId, prevAvatar, user.avatar)
        .catch(() => undefined);
    }

    return {
      ...user,
      kind: user.kind === 'bot' ? ('bot' as const) : ('person' as const),
      socialLinks: user.socialLinks as SocialLinks | null,
      dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
      idDocIssuedAt: user.idDocIssuedAt ? user.idDocIssuedAt.toISOString().slice(0, 10) : null,
    };
  }

  /**
   * Что мешает удалить аккаунт прямо сейчас — МОТИВИРОВАННЫЙ ОТКАЗ (ЗоПД ст. 8 п. 2 и п. 7:
   * отзыв согласия невозможен при неисполненном обязательстве). Показывается ДО ввода пароля:
   *  - `sole_owner` — человек владеет живой организацией (владелец один: передать либо удалить её);
   *  - `open_escrow` — есть замороженные средства по сделкам, где он плательщик или получатель;
   *  - `debt` — есть незавершённые заказы, где он покупатель или продавец.
   */
  async deletionBlockers(userId: string): Promise<AccountDeletionBlockersDto> {
    const [owned, escrow, orders] = await Promise.all([
      this.db.workspace.findMany({ where: { ownerId: userId, archivedAt: null }, select: { id: true, name: true, _count: { select: { members: true } } }, take: 50 }),
      this.db.escrowHold.count({ where: { status: 'active', OR: [{ payerType: 'user', payerUserId: userId }, { beneficiaryType: 'user', beneficiaryUserId: userId }] } }),
      this.db.order.count({ where: { status: { in: ['funding', 'pending', 'confirmed'] }, OR: [{ buyerId: userId }, { sellerId: userId }] } }),
    ]);
    const blockers: AccountDeletionBlockersDto['blockers'] = [];
    if (owned.length) blockers.push({ code: 'sole_owner', workspaces: owned.map((w) => ({ id: w.id, name: w.name, members: w._count.members })) });
    if (escrow > 0) blockers.push({ code: 'open_escrow', count: escrow });
    if (orders > 0) blockers.push({ code: 'debt', count: orders });
    return { canDelete: blockers.length === 0, blockers, graceDays: ACCOUNT_GRACE_DAYS, verifyRequired: this.verify.required };
  }

  /**
   * Удаление аккаунта = ОТЗЫВ СОГЛАСИЯ на обработку ПДн (core/consents). Порядок дверей:
   * блокеры (мотивированный отказ) → пароль → SMS-пропуск `account_delete` (в production
   * обязателен) → одна транзакция: гашение пропуска, отметка удаления, отзыв всех согласий
   * с записью в учёт действий с ПДн, уведомление. Грейс `ACCOUNT_GRACE_DAYS` укладывается в
   * 15 рабочих дней (ЗоПД ст. 8 п. 7); вход в грейс восстанавливает аккаунт, а согласия человек
   * принимает заново (шлюз). После коммита владельцу уходит SMS «не вы? войдите, чтобы отменить» —
   * защита от удаления с угнанной сессии.
   */
  async scheduleDeletion(userId: string, input: { password: string; verifyToken?: string; eraseMessages?: boolean }): Promise<AccountDeletionResultDto> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) {
      throw notFound('auth.accountNotFound');
    }
    const state = await this.deletionBlockers(userId);
    if (!state.canDelete) {
      throw conflict('account.deletionBlocked', undefined, { blockers: state.blockers });
    }
    const ok = await bcrypt.compare(input.password, user.password);
    if (!ok) {
      throw unauthorized('auth.wrongPassword');
    }
    if (this.verify.required && !input.verifyToken) {
      throw badRequest('auth.verifyRequired');
    }
    const scheduledAt = new Date();
    const purgeAt = new Date(scheduledAt.getTime() + ACCOUNT_GRACE_DAYS * 86_400_000);
    let consentsAfterCommit: (() => Promise<void>) | null = null;
    let revokedFamilies: string[] = [];
    let receipt = '';
    await this.db.$transaction(async (tx) => {
      if (input.verifyToken) {
        await this.verify.consume(tx, { verifyToken: input.verifyToken, purpose: 'account_delete', expectedUserId: userId });
      }
      // status-guarded: два одновременных запроса не дают двух отзывов и двух SMS
      const { count } = await tx.user.updateMany({ where: { id: userId, deletionScheduledAt: null, deletedAt: null }, data: { deletionScheduledAt: scheduledAt } });
      if (count === 0) throw conflict('account.deletionAlreadyScheduled');
      consentsAfterCommit = (await this.consents.revokeAllForSubject(tx, { type: 'user', id: userId }, 'account_deleted', userId)).afterCommit;
      await this.audit.record(tx, { key: 'account.deletion_requested', subjectUserId: userId, details: { graceDays: ACCOUNT_GRACE_DAYS } });
      // Заявка на стирание (оркестратор core/lifecycle): джоб в срок, этапы, сертификат. Код
      // квитанции — единственный путь человека к сертификату, когда аккаунта уже нет
      receipt = (await this.erasure.request(tx, { subject: { type: 'user', id: userId }, effectiveAt: purgeAt, options: { eraseMessages: !!input.eraseMessages } })).receipt;
      // SMS уходит отдельной дверью ниже (безусловно), поэтому канал sms движка выключен — иначе две SMS
      await this.notifications.send(tx, {
        type: 'account.deletionScheduled',
        to: [{ userId }],
        payload: { days: ACCOUNT_GRACE_DAYS, purgeAtIso: purgeAt.toISOString() },
        actorId: userId,
        includeActor: true,
        channels: { sms: false },
        actionUrl: '/login',
        reason: 'system',
      });
      // Выход везде (мягко: «вышедшие устройства» и улики остаются); аккаунт скрыт до восстановления входом
      revokedFamilies = (await this.sessions.revokeFamilies(tx, userId, {}, 'deleted')).families;
    });
    await this.sessions.markFamiliesRevoked(revokedFamilies);
    // Личные ключи API гаснут сразу: восстановление аккаунта их не вернёт (ключ = сессия без срока)
    await this.keysCascades.onDeletionScheduled(userId);
    // Кабинет платформы — отдельный контур со своими строками сессий: «выйти везде»
    // обязано гасить и его (токен там живёт 8 часов без refresh).
    await this.db.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.redis.invalidateUserProfile(userId);
    // JWT-guard кэширует «аккаунт жив» на 60с — удаление обязано сбросить кэш сразу.
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    await this.consentsGate.forgetUser(userId);
    // Эффекты отзыва согласий вне базы (отзыв токена у Google) — после коммита, best-effort
    await (consentsAfterCommit as (() => Promise<void>) | null)?.().catch(() => undefined);
    // Live messenger sockets must drop too (socket auth is handshake-only).
    this.events.emit('auth.sessions.revoked', { userId }, 'users');
    // SMS владельцу — best-effort: аккаунт УЖЕ скрыт, и 500 из-за упавшего шлюза читался бы как «не удалился»
    const locale = coerceLocale(user.locale);
    this.smsOutbound
      .sendAccountAlert(userId, user.phone, this.i18n.translateFor(locale, 'notifications.sms.accountDeletionScheduled', { days: ACCOUNT_GRACE_DAYS }))
      .then((sent) => (sent ? this.pdActions.record(null, { subjectId: userId, recipient: 'kazinfoteh', fields: ['phone', 'notification_text'], purpose: 'service_sms', refType: 'account_deletion', refId: userId }) : undefined))
      .catch((err) => this.logger.warn(`The account deletion SMS was not sent: ${(err as Error).message}`));
    return { scheduled: true, gracePeriodDays: ACCOUNT_GRACE_DAYS, purgeAt: purgeAt.toISOString(), receipt };
  }

  /**
   * Смена пароля из профиля (движок core/verify): текущий пароль + SMS-код на свой
   * номер (purpose=password_change — Kaspi-модель step-up). Отзываются все ДРУГИЕ
   * сессии (текущая, чей refresh передан, живёт); уведомление в ленту.
   *
   * Пароль здесь проверяется ВТОРОЙ раз: первый — при запуске цепочки (движок не даёт
   * жечь SMS до верного пароля), этот — на случай, если пароль сменили между шагами.
   */
  async changePassword(actor: JwtPayload, input: ChangePasswordInput) {
    const userId = actor.sub;
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { password: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw notFound('auth.accountNotFound');
    const ok = await bcrypt.compare(input.currentPassword, user.password);
    if (!ok) throw unauthorized('auth.wrongCurrentPassword');

    const hashedPassword = await bcrypt.hash(input.newPassword, 12); // CPU — до транзакции
    const keep = await this.currentFamily(actor, input.currentRefreshToken);

    const revoked = await this.db.$transaction(async (tx) => {
      // Гашение SMS-пропуска в транзакции смены: откат = пропуск не потрачен.
      const consumed = await this.verify.consume(tx, {
        verifyToken: input.verifyToken,
        purpose: 'password_change',
        expectedUserId: userId,
      });
      await tx.user.update({
        where: { id: userId },
        // Поколение токенов вперёд: чужие ACCESS-токены (а не только refresh-строки)
        // умирают сразу. Текущая вкладка переживает это прозрачно — её refresh цел,
        // и клиентский single-flight refresh выдаст токен нового поколения.
        data: { password: hashedPassword, tokenEpoch: { increment: 1 } },
      });
      // Другие семейства — мягко (улика и «вышедшие устройства» остаются); текущее живёт
      const r = await this.sessions.revokeFamilies(tx, userId, { except: keep }, 'password_change');
      // Событие и уведомление (паспорт реестра) — В ТРАНЗАКЦИИ смены: смена без следа невозможна
      await this.audit.record(tx, {
        key: 'auth.password.changed',
        subjectUserId: userId,
        details: { via: input.via ?? 'settings', sessionsRevoked: r.count },
        evidence: { factor: 'password+sms', verifyChallengeId: consumed.challengeId },
      });
      return r;
    });

    // Кэш «жив», отметки отозванных семейств, сокеты со старыми сессиями
    await this.account.afterAccessRevoked(userId, revoked.families);
    return { changed: true };
  }

  /** Семейство текущей сессии: из `fam` токена, иначе по переданному refresh-токену (клиенты прошлой версии). */
  private async currentFamily(actor: JwtPayload, refreshToken?: string): Promise<string | null> {
    const fromToken = await this.sessions.currentFamilyOf(actor);
    if (fromToken) return fromToken;
    if (!refreshToken) return null;
    const row = await this.db.session.findFirst({ where: { userId: actor.sub, token: this.hashRefreshToken(refreshToken) }, select: { familyId: true } });
    return row?.familyId ?? null;
  }

  /**
   * Смена номера телефона (строгий v1 — решение продукта): пароль + SMS-код на СТАРЫЙ
   * номер + SMS-код на НОВЫЙ (оба пропуска гасятся в одной транзакции со сменой).
   * Кейс «старый номер утерян» осознанно НЕ поддержан (v2 — задержка 48ч с отменой).
   * После смены: pending-приглашения, висевшие на новом номере, активируются —
   * та же механика, что при регистрации нового пользователя.
   */
  async changePhone(actor: JwtPayload, input: ChangePhoneInput) {
    const userId = actor.sub;
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { phone: true, password: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw notFound('auth.accountNotFound');
    const ok = await bcrypt.compare(input.password, user.password);
    if (!ok) throw unauthorized('auth.wrongPassword');

    const keep = await this.currentFamily(actor, input.currentRefreshToken);

    const revoked = await this.db.$transaction(async (tx) => {
      // Оба владения доказаны: старым номером (никто не уводит аккаунт с угнанной
      // сессией+паролем на свою симку) и новым (не привяжем чужой/опечатанный номер).
      await this.verify.consume(tx, {
        verifyToken: input.oldVerifyToken,
        purpose: 'phone_change_old',
        expectedUserId: userId,
        expectedPhone: user.phone,
      });
      await this.verify.consume(tx, {
        verifyToken: input.newVerifyToken,
        purpose: 'phone_change_new',
        expectedUserId: userId,
        expectedPhone: input.newPhone,
      });
      // Гонка «номер заняли между start и сменой» ловится @unique(phone) → P2002 → 409.
      await tx.user.update({
        where: { id: userId },
        data: { phone: input.newPhone, phoneVerifiedAt: new Date(), tokenEpoch: { increment: 1 } },
      });
      const r = await this.sessions.revokeFamilies(tx, userId, { except: keep }, 'phone_change');
      // Приглашения (Окружение + организации), отправленные на новый номер, пока он
      // был «ничьим», теперь адресованы этому аккаунту. Это ОБЯЗАТЕЛЬНАЯ работа, а не
      // сигнал: раньше два вызова шли после транзакции голыми await'ами — упал первый,
      // второй не выполнился, а номер уже сменён, и приглашения организации потерялись
      // навсегда. Джоб ставится В ЭТОЙ ЖЕ транзакции (правило платформы: обязательное —
      // в core/jobs; коммит = работа будет сделана, откат = джоба нет).
      await this.jobs.enqueue(tx, {
        type: USER_PHONE_INVITATIONS_JOB,
        payload: { userId, phone: input.newPhone },
        uniqueKey: `phone-inv:${userId}:${input.newPhone}`,
      });
      // Событие и уведомление — В ТРАНЗАКЦИИ смены (раньше уведомление шло после коммита и
      // могло потеряться: смена номера без следа для владельца — ровно то, что ищет угонщик)
      await this.audit.record(tx, { key: 'auth.phone.changed', subjectUserId: userId, details: { sessionsRevoked: r.count } });
      await this.notifications.send(tx, {
        type: 'auth.phone.changed',
        to: [{ userId }],
        payload: { newPhoneMasked: maskPhone(input.newPhone) },
        reason: 'system',
        actorId: userId,
        includeActor: true,
        actionUrl: '/profile/security',
      });
      return r;
    });

    await this.redis.invalidateUserProfile(userId);
    await this.account.afterAccessRevoked(userId, revoked.families);
    return { changed: true, phone: input.newPhone };
  }

  /**
   * Обработчик джоба активации приглашений после смены номера. Идемпотентен:
   * обе сервисные функции берут только строки с toUserId=null, повторный заход
   * ничего не дублирует. Аккаунта уже нет → работа потеряла смысл (постоянная
   * ошибка, а не транзиентная) → хороним без ретраев.
   */
  private async runPhoneInvitationsJob(payload: Record<string, unknown>) {
    const userId = String(payload.userId);
    const phone = String(payload.phone);
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { phone: true, deletedAt: true } });
    if (!user || user.deletedAt) {
      throw new JobDiscardError(`Account ${userId} is deleted — there is nobody to activate the invitations for`);
    }
    if (user.phone !== phone) {
      throw new JobDiscardError(`The phone number of account ${userId} is already different — the job is stale`);
    }
    await this.contacts.activatePendingInvitationsForNewUser(userId, phone);
    await this.workspaces.activatePendingWorkspaceInvitationsForNewUser(userId, phone);
  }

  /**
   * Детерминированный SHA-256 refresh-токена — тот же примитив, что в AuthService
   * (поиск по равенству на unique session.token; токен высокоэнтропийный).
   */
  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Cancel a pending deletion (called on login during the grace window). */
  async restoreAccount(userId: string) {
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({ where: { id: userId, deletionScheduledAt: { not: null }, deletedAt: null }, data: { deletionScheduledAt: null } });
      if (count) {
        await this.audit.record(tx, { key: 'account.deletion_cancelled', subjectUserId: userId, details: {} });
        await this.erasure.cancel(tx, { type: 'user', id: userId });
      }
    });
    await this.redis.invalidateUserProfile(userId);
  }

  /**
   * Батч-чистка сессий (AccountCron) — таблица иначе растёт вечно. Отозванные и истёкшие строки
   * живут ещё 90 дней: «Вышедшие устройства» и улики reuse (журнал безопасности хранит события,
   * а строка — контекст семейства). Прокрученные строки нужны до своего срока (сигнал повтора).
   */
  async purgeExpiredSessions(): Promise<number> {
    const BATCH = 10_000;
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    let total = 0;
    for (;;) {
      const rows = await this.db.session.findMany({
        where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
        select: { id: true },
        take: BATCH,
      });
      if (!rows.length) break;
      const res = await this.db.session.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      total += res.count;
      if (rows.length < BATCH) break;
    }
    return total;
  }

  /**
   * Корневой шаг стирания человека (`users.account`, оркестратор core/lifecycle; «право на
   * забвение»). Строка не удаляется — совместный контент (задачи, чаты, организации) цел,
   * автор рисуется томбстоуном. Два под-шага, оба идемпотентны:
   *  1) СКРЫТЬ — `deletedAt` (вход закрыт навсегда, эпоха токенов, сокеты). Идёт ВСЕГДА, даже
   *     под заморозкой: заморозка держит данные, не доступ;
   *  2) СТЕРЕТЬ — ПДн строки, связи Окружения, тариф, аналитика, ключи (KEK на уничтожение),
   *     роли, номер освобождается. Под заморозкой хранителя НЕ идёт (ПДн — улика процесса):
   *     шаг вернёт «удерживается», оркестратор повторит его после снятия.
   * Срок проверяет оркестратор (джоб в срок); здесь — только «удаление запрошено».
   */
  async eraseAccount(userId: string, ctx: LifecycleSubjectEraseContext): Promise<{ rows: number }> {
    // JWT-guard кэширует «жив» — терминальное удаление чистит кэш первым делом.
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    const hidden = await this.db.user.updateMany({
      where: { id: userId, deletedAt: null, deletionScheduledAt: { not: null } },
      data: { deletedAt: new Date(), tokenEpoch: { increment: 1 } },
    });
    const state = await this.db.user.findUnique({ where: { id: userId }, select: { phone: true, deletedAt: true } });
    if (!state?.deletedAt) throw new Error(`account ${userId} is not scheduled for erasure — nothing to hide`);
    // Живые сокеты рвём, как и все остальные пути отзыва (сброс/смена пароля, смена
    // номера, logout-all, планирование удаления)
    if (hidden.count) this.events.emit('auth.sessions.revoked', { userId }, 'users');
    // Уже стёрто (повтор шага) — номер освобождён меткой
    if (state.phone === `deleted:${userId}`) return { rows: 0 };
    if (ctx.subjectHeld) {
      ctx.held(1);
      return { rows: 0 };
    }
    // Former contacts whose contactsCount changes — bust their caches afterwards.
    const links = await this.db.contactLink.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      select: { userAId: true, userBId: true },
    });
    const others = new Set<string>();
    for (const l of links) {
      others.add(l.userAId === userId ? l.userBId : l.userAId);
    }

    // Access-engine cleanup targets, captured BEFORE the transaction deletes
    // the rows: the user's own Groups (all their mirrored tuples drop) and the
    // user's memberships in OTHER people's Groups (there the member is this
    // user). Without the explicit revoke, group-granted visibility would
    // outlive the account until the nightly AccessReconcileCron.
    const ownedCircles = await this.db.circle.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    const foreignMemberships = await this.db.circleMembership.findMany({
      where: {
        contactLink: { OR: [{ userAId: userId }, { userBId: userId }] },
        circle: { ownerId: { not: userId } },
      },
      select: { circleId: true },
    });

    const deadHash = await bcrypt.hash(randomUUID(), 12);

    const anonymized = await this.db.$transaction(async (tx) => {
      // Атомарный клейм стирания: строка блокируется ПЕРВЫМ оператором, номер-метка ставится
      // сразу — параллельный заход (ретрай джоба, второй инстанс) ждёт замка и видит метку, каскад
      // дважды не пройдёт. Номер — зашифрованное поле (ключ на строку): только одиночный update,
      // массовый updateMany расширение ПДн отвергает. Скрытый аккаунт восстановить нельзя —
      // гонки с «вернулся в грейс» здесь уже нет (её закрыл шаг «скрыть»).
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM "users" WHERE id = ${userId}::uuid AND deleted_at IS NOT NULL FOR UPDATE`;
      if (!locked.length) return false;
      const current = await tx.user.findUnique({ where: { id: userId }, select: { phone: true } });
      if (!current || current.phone === `deleted:${userId}`) return false;
      await tx.user.update({ where: { id: userId }, data: { phone: `deleted:${userId}` } });

      // Ключи API, созданные боты, KEK человека (crypto-shredding зашифрованных ПДн)
      await this.keysCascades.onAccountAnonymize(tx, userId);

      // Remove from everyone's environment (bilateral); clear pending invites/blocks.
      await tx.contactLink.deleteMany({
        where: { OR: [{ userAId: userId }, { userBId: userId }] },
      });
      // Приглашения человека и к нему — стираются (реестр: hard_delete), а не гасятся статусом
      await tx.contactInvitation.deleteMany({ where: { OR: [{ fromUserId: userId }, { toUserId: userId }] } });
      await tx.contactBlock.deleteMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      });
      await tx.circle.deleteMany({ where: { ownerId: userId } }); // cascades memberships
      // Политики видимости человека (полиморфный владелец, без FK) и его место в чужих
      // исключениях — иначе пережили бы аккаунт навсегда (core/visibility, R1)
      await this.visibilityPolicies.purgeOwner(tx, 'user', userId);
      await tx.session.deleteMany({ where: { userId } });
      // Устройства (подписи, UA-семейства) — ПДн аккаунта; журнал безопасности остаётся (срок
      // хранения по закону), а устройства человека, которого больше нет, — нет
      await tx.userDevice.deleteMany({ where: { userId } });
      await this.audit.record(tx, { key: 'account.anonymized', subjectUserId: userId, actor: { kind: 'system' }, details: {} });
      // След человека вне его строки (хроника, снимки уведомлений) — шаги оркестратора
      // `chatter.subject` / `notifications.subject` (пачками, с продолжением после сбоя).
      // Роли стираются (реестр: hard_delete): неактивная строка роли — лишняя ссылка на человека
      await tx.userRole.deleteMany({ where: { userId } });
      // Тариф: подписки, гранты, оверрайды и счётчики — полиморфные строки без FK
      await this.entitlements.forgetSubject(tx, { type: 'user', id: userId });
      // Аналитика человека — свой шаг оркестратора (`analytics.subject`): первый проход сразу, второй джобом
      // Кабинет платформы: сотрудник на анонимизированном аккаунте оставался активным —
      // он числился в штате, попадал в адресаты заявок four-eyes и в получатели
      // security-alert. Снимаем со штата и гасим его консольные сессии.
      await this.platformAccess.systemSuspendDeletedUser(tx, userId);

      // Scrub PII; keep the row so tasks/comments/workspaces stay intact.
      // (deletedAt was already set by the atomic claim above.)
      await tx.user.update({
        where: { id: userId },
        data: {
          // Имя ложится В БД — снимок в языке ИСТОЧНИКА (зритель перерисует его при чтении).
          firstName: DELETED_USER_MARKER,
          lastName: null,
          phoneVerifiedAt: null, // подтверждение принадлежало освобождённому номеру
          email: null,
          // Удостоверяющие данные: без них «удалённый» аккаунт продолжал бы хранить ИИН, адрес
          // и номер документа открытым текстом (шифротексты гаснут вместе с KEK, открытые колонки — нет)
          middleName: null,
          iin: null,
          residentialAddress: null,
          idDocNumber: null,
          idDocIssuedBy: null,
          idDocIssuedAt: null,
          password: deadHash, // unusable
          avatar: null,
          bio: null,
          city: null,
          dateOfBirth: null,
          maritalStatus: null,
          socialLinks: Prisma.JsonNull,
          deletionScheduledAt: null,
        },
      });
      return true;
    });

    // Параллельный заход уже стёр — ничего не менялось
    if (!anonymized) return { rows: 0 };

    // KEK человека ушёл на уничтожение — кэши keystore сбрасываются ПОСЛЕ коммита
    await this.keysCascades.afterScopeDestroyCommitted();

    // Drop the mirrored access edges (best-effort, reconcile is the safety net).
    for (const c of ownedCircles) {
      await this.accessProjection.circleDeleted(c.id);
    }
    for (const m of foreignMemberships) {
      await this.accessProjection.circleMemberRemoved(m.circleId, userId);
    }

    // Drop any live messenger sockets of the now-anonymized account.
    this.events.emit('auth.sessions.revoked', { userId }, 'users');

    // Bust caches for the anonymized user and every former contact.
    await this.redis.invalidateUserProfile(userId);
    await this.redis.del(`user:${userId}:roles`);
    await Promise.all(
      [...others].map((id) => this.redis.invalidateUserProfile(id)),
    );
    return { rows: 1 };
  }

  /**
   * Посев канарейки стирания для корневого шага: аккаунт глазами `users.account` — сессия
   * (отозванная), устройство, SMS-цепочка, сессия Кабинета (отозванная), роли человека (роль в
   * организации канарейки заведена её фабрикой), связь и приглашение Окружения, блок, Группа с
   * соседом. Номера — `canary:` (ни SMS, ни совпадения с живым номером). Всё обязано исчезнуть.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const u = ctx.userId;
    // Строка аккаунта остаётся томбстоуном («удалённый пользователь») — без фамилии-маркера
    const plants: LifecycleCanaryPlant[] = [{ policy: 'User', id: u, expect: 'kept' }];
    const gone = (policy: string, id: string) => plants.push({ policy, id, expect: 'gone' });
    const inHour = new Date(Date.now() + 3_600_000);
    gone('Session', (await this.db.session.create({ data: { userId: u, token: `canary:${randomUUID()}`, expiresAt: inHour, deviceInfo: ctx.marker, revokedAt: new Date(), revokedReason: 'self' }, select: { id: true } })).id);
    gone('UserDevice', (await this.db.userDevice.create({ data: { userId: u, deviceId: randomUUID(), label: ctx.marker }, select: { id: true } })).id);
    gone(
      'VerifyChallenge',
      (await this.db.verifyChallenge.create({ data: { userId: u, phone: `canary:${u}`, purpose: 'password_change', codeHash: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: inHour, delivery: 'simulated' }, select: { id: true } })).id,
    );
    gone('PlatformSession', (await this.db.platformSession.create({ data: { userId: u, expiresAt: inHour, revokedAt: new Date(), userAgent: ctx.marker }, select: { id: true } })).id);
    for (const r of await this.db.userRole.findMany({ where: { userId: u }, select: { id: true }, take: 100 })) gone('UserRole', r.id);
    const link = await this.db.contactLink.create({ data: { userAId: u, userBId: ctx.peerId, initiatedBy: u, roleAForB: ctx.marker }, select: { id: true } });
    gone('ContactLink', link.id);
    gone(
      'ContactInvitation',
      (await this.db.contactInvitation.create({ data: { fromUserId: u, toPhone: `canary:${randomUUID()}`, message: ctx.marker, expiresAt: inHour }, select: { id: true } })).id,
    );
    gone('ContactBlock', (await this.db.contactBlock.create({ data: { blockerId: u, blockedId: ctx.peerId }, select: { id: true } })).id);
    const circle = await this.db.circle.create({ data: { ownerId: u, name: ctx.marker, memberships: { create: { contactLinkId: link.id } } }, select: { id: true } });
    gone('Circle', circle.id);
    return plants;
  }

  /** Поиск по номеру глазами зрителя: находимость + минимальная карточка по правилам владельца. */
  async lookupForViewer(viewerId: string, phone: string): Promise<UserLookupDto | null> {
    const row = await this.db.user.findUnique({ where: { phone }, select: { ...USER_CARD_SELECT, deletedAt: true, kind: true } });
    if (!row || row.deletedAt || row.kind === 'bot') return null;
    const viewer = this.visibility.viewer('api', { workspaceId: null });
    if (!(await this.discoverability.isDiscoverable(row.id, viewerId, viewer.kind === 'bot' ? 'bot' : 'user'))) return null;
    const card = await this.userCards.card(viewer, row);
    return markShaped({ id: row.id, phone: row.phone, firstName: card.firstName, lastName: card.lastName, avatar: card.avatar });
  }

  /** Своя карточка глазами синтетического зрителя («Как видит»). Группа — только своя. */
  async cardPreview(userId: string, q: VisibilityPreviewQuery): Promise<ContactUserCard> {
    const row = await this.db.user.findUnique({ where: { id: userId }, select: USER_CARD_SELECT });
    if (!row) throw notFound('auth.userNotFound');
    if (q.as === 'circle') {
      const own = await this.db.circle.count({ where: { id: q.id!, ownerId: userId } });
      if (!own) throw notFound('contacts.circleNotFound');
    }
    const as: VisibilityPreviewAs =
      q.as === 'circle' ? { kind: 'circle', id: q.id! } : q.as === 'colleague' ? { kind: 'colleague', workspaceId: q.id! } : q.as === 'user' ? { kind: 'user', id: q.id! } : { kind: q.as };
    return this.userCards.preview(row, as);
  }
}
