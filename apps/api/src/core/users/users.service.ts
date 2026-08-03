import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
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
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { USER_PHONE_INVITATIONS_JOB } from './user-jobs';
import { ContactsService } from '../../modules/contacts/contacts.service';
import { WorkspacesService } from '../../modules/workspaces/workspaces.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import {
  maskPhone,
  resolveCardVisibility,
  type CardVisibility,
  type ChangePasswordInput,
  type ChangePhoneInput,
  type UpdateProfileInput,
} from '@superapp/shared';

/** Days a deleted account stays recoverable before permanent anonymization. */
export const ACCOUNT_GRACE_DAYS = 30;

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
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(USER_PHONE_INVITATIONS_JOB, (payload) => this.runPhoneInvitationsJob(payload));
  }

  async getProfile(userId: string) {
    // Try cache first
    const cached = await this.redis.getJson<Record<string, unknown>>(`user:${userId}:profile`);
    if (cached) return cached;

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        avatar: true,
        bio: true,
        city: true,
        email: true,
        maritalStatus: true,
        socialLinks: true,
        onlineStatusMode: true,
        phoneVerifiedAt: true,
        locale: true,
        timezone: true,
        iin: true,
        residentialAddress: true,
        idDocNumber: true,
        idDocIssuedBy: true,
        idDocIssuedAt: true,
        cardVisibility: true,
        companyCardVisibility: true,
        createdAt: true,
        updatedAt: true,
        subscription: {
          select: {
            plan: true,
            status: true,
            expiresAt: true,
            giftedBy: true,
          },
        },
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
      throw new NotFoundException('Пользователь не найден');
    }

    const { _count, subscription, cardVisibility, companyCardVisibility, dateOfBirth, phoneVerifiedAt, idDocIssuedAt, ...rest } = user;

    const profile = {
      ...rest,
      // Наружу — прежний boolean (веб/mobile не меняются); истина в БД — timestamp.
      isVerified: !!phoneVerifiedAt,
      dateOfBirth: dateOfBirth ? dateOfBirth.toISOString().slice(0, 10) : null,
      idDocIssuedAt: idDocIssuedAt ? idDocIssuedAt.toISOString().slice(0, 10) : null,
      // Owner's DEFAULT visibility — applied to contacts in none of the
      // owner's groups. Per-group visibility lives on Circle.
      cardVisibility: resolveCardVisibility(
        cardVisibility as Parameters<typeof resolveCardVisibility>[0],
      ),
      // «Видимость в Компаниях» — что видят коллеги по организации в ростере.
      companyCardVisibility: resolveCardVisibility(
        companyCardVisibility as Parameters<typeof resolveCardVisibility>[0],
      ),
      circlesCount: _count.ownedCircles,
      workspacesCount: _count.workspaceMembers,
      contactsCount: _count.contactLinksA + _count.contactLinksB,
      activeSubscription: subscription,
    };

    // Cache for 5 minutes
    await this.redis.setJson(`user:${userId}:profile`, profile, 300);

    return profile;
  }

  async updateProfile(userId: string, data: UpdateProfileInput) {
    const { dateOfBirth, cardVisibility, companyCardVisibility, socialLinks, ...rest } = data;
    // Аватар хранится ССЫЛКОЙ (не FileLink) → при замене прибираем прежний файл сами,
    // иначе каждая смена аватара навсегда копит квоту (публичные файлы крон не свипает).
    const prevAvatar =
      rest.avatar !== undefined
        ? (await this.db.user.findUnique({ where: { id: userId }, select: { avatar: true } }))?.avatar
        : undefined;

    // Карты видимости пишутся МЕРЖЕМ над текущей, а не заменой. Схема допускает
    // частичный объект (все поля optional), и `PATCH {cardVisibility:{city:false}}`
    // затирал всю карту: недостающие поля на чтении добирались из ПЛАТФОРМЕННЫХ
    // дефолтов, где био/возраст/соцсети открыты, — то есть частичное сужение
    // молча ОТКРЫВАЛО ранее скрытые поля. Видимость групп (CirclesService) уже
    // мержится; теперь контракт один и тот же.
    const mergeVisibility = (
      current: unknown,
      patch: Partial<CardVisibility> | null | undefined,
    ): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => {
      if (patch === undefined) return undefined;
      // Явный null — осознанный сброс «как у всех» (платформенные дефолты),
      // в отличие от частичного объекта, который мержится над текущим.
      if (patch === null) return Prisma.JsonNull;
      const base = resolveCardVisibility(current as Partial<CardVisibility> | null);
      return resolveCardVisibility({
        ...base,
        ...patch,
        extras: { ...(base.extras ?? {}), ...(patch.extras ?? {}) },
      }) as unknown as Prisma.InputJsonValue;
    };

    const needsVisibilityMerge =
      cardVisibility !== undefined || companyCardVisibility !== undefined;
    const currentVisibility = needsVisibilityMerge
      ? await this.db.user.findUnique({
          where: { id: userId },
          select: { cardVisibility: true, companyCardVisibility: true },
        })
      : null;

    const user = await this.db.user.update({
      where: { id: userId },
      data: {
        ...rest,
        ...(dateOfBirth !== undefined && {
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        }),
        ...(cardVisibility !== undefined && {
          cardVisibility: mergeVisibility(
            currentVisibility?.cardVisibility,
            cardVisibility,
          ),
        }),
        ...(companyCardVisibility !== undefined && {
          companyCardVisibility: mergeVisibility(
            currentVisibility?.companyCardVisibility,
            companyCardVisibility,
          ),
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
        dateOfBirth: true,
        avatar: true,
        bio: true,
        city: true,
        email: true,
        maritalStatus: true,
        socialLinks: true,
        onlineStatusMode: true,
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
      dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
      idDocIssuedAt: user.idDocIssuedAt ? user.idDocIssuedAt.toISOString().slice(0, 10) : null,
    };
  }

  /**
   * Request account deletion. Nothing is destroyed yet — the account enters a
   * recoverable grace window (logging in restores it; see AuthService.login).
   * A cron permanently anonymizes accounts whose window elapses. Requires the
   * current password to confirm.
   */
  async scheduleDeletion(userId: string, password: string) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) {
      throw new NotFoundException('Аккаунт не найден');
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      throw new UnauthorizedException('Неверный пароль');
    }
    await this.db.user.update({
      where: { id: userId },
      data: { deletionScheduledAt: new Date() },
    });
    // Log out everywhere; the account stays hidden until restored via login.
    await this.db.session.deleteMany({ where: { userId } });
    await this.redis.invalidateUserProfile(userId);
    // JWT-guard кэширует «аккаунт жив» на 60с — удаление обязано сбросить кэш сразу.
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    // Live messenger sockets must drop too (socket auth is handshake-only).
    this.events.emit('auth.sessions.revoked', { userId }, 'users');
    return { scheduled: true, gracePeriodDays: ACCOUNT_GRACE_DAYS };
  }

  /**
   * Смена пароля из профиля (движок core/verify): текущий пароль + SMS-код на свой
   * номер (purpose=password_change — Kaspi-модель step-up). Отзываются все ДРУГИЕ
   * сессии (текущая, чей refresh передан, живёт); уведомление в ленту.
   *
   * Пароль здесь проверяется ВТОРОЙ раз: первый — при запуске цепочки (движок не даёт
   * жечь SMS до верного пароля), этот — на случай, если пароль сменили между шагами.
   */
  async changePassword(userId: string, input: ChangePasswordInput) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { password: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new NotFoundException('Аккаунт не найден');
    const ok = await bcrypt.compare(input.currentPassword, user.password);
    if (!ok) throw new UnauthorizedException('Неверный текущий пароль');

    const hashedPassword = await bcrypt.hash(input.newPassword, 12); // CPU — до транзакции
    const keepToken = input.currentRefreshToken ? this.hashRefreshToken(input.currentRefreshToken) : null;

    await this.db.$transaction(async (tx) => {
      // Гашение SMS-пропуска в транзакции смены: откат = пропуск не потрачен.
      await this.verify.consume(tx, {
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
      await tx.session.deleteMany({
        where: { userId, ...(keepToken ? { NOT: { token: keepToken } } : {}) },
      });
    });

    await this.redis.invalidateUserProfile(userId);
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    // Сокеты со старыми сессиями рвём; текущая вкладка переподключится живым access-токеном.
    this.events.emit('auth.sessions.revoked', { userId }, 'users');
    // Уведомление не имеет права уронить ответ: пароль УЖЕ сменён, а 500 клиенту
    // читается как «не сменился» и провоцирует повтор с уже негодным пропуском.
    this.notifications
      .notify(userId, 'auth.password.changed', {})
      .catch((err) => this.logger.error(`Уведомление о смене пароля не создано: ${err.message}`));
    return { changed: true };
  }

  /**
   * Смена номера телефона (строгий v1 — решение продукта): пароль + SMS-код на СТАРЫЙ
   * номер + SMS-код на НОВЫЙ (оба пропуска гасятся в одной транзакции со сменой).
   * Кейс «старый номер утерян» осознанно НЕ поддержан (v2 — задержка 48ч с отменой).
   * После смены: pending-приглашения, висевшие на новом номере, активируются —
   * та же механика, что при регистрации нового пользователя.
   */
  async changePhone(userId: string, input: ChangePhoneInput) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { phone: true, password: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new NotFoundException('Аккаунт не найден');
    const ok = await bcrypt.compare(input.password, user.password);
    if (!ok) throw new UnauthorizedException('Неверный пароль');

    const keepToken = input.currentRefreshToken ? this.hashRefreshToken(input.currentRefreshToken) : null;

    await this.db.$transaction(async (tx) => {
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
      await tx.session.deleteMany({
        where: { userId, ...(keepToken ? { NOT: { token: keepToken } } : {}) },
      });
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
    });

    await this.redis.invalidateUserProfile(userId);
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    this.events.emit('auth.sessions.revoked', { userId }, 'users');
    this.notifications
      .notify(userId, 'auth.phone.changed', { newPhoneMasked: maskPhone(input.newPhone) })
      .catch((err) => this.logger.error(`Уведомление о смене номера не создано: ${err.message}`));
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
      throw new JobDiscardError(`Аккаунт ${userId} удалён — активировать приглашения некому`);
    }
    if (user.phone !== phone) {
      throw new JobDiscardError(`Номер аккаунта ${userId} уже другой — джоб устарел`);
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
    await this.db.user.update({
      where: { id: userId },
      data: { deletionScheduledAt: null },
    });
    await this.redis.invalidateUserProfile(userId);
  }

  /** Батч-чистка протухших refresh-сессий (AccountCron) — таблица иначе растёт вечно. */
  async purgeExpiredSessions(): Promise<number> {
    const BATCH = 10_000;
    let total = 0;
    for (;;) {
      const rows = await this.db.session.findMany({
        where: { expiresAt: { lt: new Date() } },
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

  /** IDs of accounts whose grace window has elapsed — driven by the deletion cron. */
  async findExpiredDeletions(graceDays: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
    const rows = await this.db.user.findMany({
      where: { deletionScheduledAt: { lt: cutoff }, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Permanently anonymize the account — "right to be forgotten". We do NOT
   * delete the user row, so collaborative content others depend on (tasks
   * assigned to them, comments, workspaces) survives. PII is scrubbed and the
   * phone is freed for re-registration. Called by the cron after the grace
   * window elapses.
   */
  async anonymizeAccount(userId: string) {
    // JWT-guard кэширует «жив» — терминальное удаление чистит кэш первым делом.
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    // Живые сокеты рвём, как и все остальные пути отзыва (сброс/смена пароля, смена
    // номера, logout-all, планирование удаления). Необратимая анонимизация — единственный
    // путь, который этого не делал, и открытое соединение её переживало.
    this.events.emit('auth.sessions.revoked', { userId }, 'users');
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
    const cutoff = new Date(Date.now() - ACCOUNT_GRACE_DAYS * 24 * 60 * 60 * 1000);

    const anonymized = await this.db.$transaction(async (tx) => {
      // Atomic claim: take the row ONLY if it's STILL pending past the grace
      // window. If the user logged back in and restored it
      // (deletionScheduledAt → null) — or re-scheduled — this matches 0 rows and
      // we abort, touching nothing. This closes the race where the cron would
      // otherwise wipe an account the user just recovered.
      const claimed = await tx.user.updateMany({
        where: { id: userId, deletedAt: null, deletionScheduledAt: { lt: cutoff } },
        data: { deletedAt: new Date() },
      });
      if (claimed.count === 0) return false;

      // Remove from everyone's environment (bilateral); clear pending invites/blocks.
      await tx.contactLink.deleteMany({
        where: { OR: [{ userAId: userId }, { userBId: userId }] },
      });
      await tx.contactInvitation.updateMany({
        where: {
          status: 'pending',
          OR: [{ fromUserId: userId }, { toUserId: userId }],
        },
        data: { status: 'cancelled', respondedAt: new Date() },
      });
      await tx.contactBlock.deleteMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      });
      await tx.circle.deleteMany({ where: { ownerId: userId } }); // cascades memberships
      await tx.session.deleteMany({ where: { userId } });
      await tx.userRole.updateMany({
        where: { userId },
        data: { isActive: false },
      });
      await tx.subscription.updateMany({
        where: { userId },
        data: { status: 'cancelled' },
      });

      // Scrub PII; keep the row so tasks/comments/workspaces stay intact.
      // (deletedAt was already set by the atomic claim above.)
      await tx.user.update({
        where: { id: userId },
        data: {
          firstName: 'Удалённый пользователь',
          lastName: null,
          phone: `deleted:${userId}`, // frees the real number for re-registration
          phoneVerifiedAt: null, // подтверждение принадлежало освобождённому номеру
          email: null,
          password: deadHash, // unusable
          avatar: null,
          bio: null,
          city: null,
          dateOfBirth: null,
          maritalStatus: null,
          socialLinks: Prisma.JsonNull,
          cardVisibility: Prisma.JsonNull,
          deletionScheduledAt: null,
        },
      });
      return true;
    });

    // Restored / re-scheduled in the meantime → nothing was changed, skip.
    if (!anonymized) return;

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
  }

  async findByPhone(phone: string) {
    return this.db.user.findUnique({
      where: { phone },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        avatar: true,
      },
    });
  }

  async getSessions(userId: string) {
    return this.db.session.findMany({
      where: { userId },
      select: {
        id: true,
        deviceInfo: true,
        lastActive: true,
        createdAt: true,
      },
      orderBy: { lastActive: 'desc' },
    });
  }

  async deleteSession(userId: string, sessionId: string) {
    const session = await this.db.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!session) throw new NotFoundException('Сессия не найдена');
    if (session.userId !== userId) throw new ForbiddenException('Это не ваша сессия');
    await this.db.session.delete({ where: { id: sessionId } });
  }
}
