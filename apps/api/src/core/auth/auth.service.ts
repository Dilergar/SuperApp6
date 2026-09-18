import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { badRequest, conflict, unauthorized } from '../../shared/errors/api-error';
import { KEYS_LIMITS } from '@superapp/shared';
import { KeysSigningService } from '../keys/keys.signing.service';
import { legacySecret } from '../keys/keys.legacy';
import { parseDurationSec } from '../keys/keys.jwt';
// Нативный bcrypt (libuv threadpool): bcryptjs считал cost-12 хэш НА event-loop'е
// (~0.5–1.5с CPU) — десяток одновременных логинов душил все запросы инстанса.
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KeysCascadesService } from '../keys/api-keys/keys.cascades.service';
import { VerifyService } from '../verify/verify.service';
import { JobsService } from '../jobs/jobs.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { USER_PHONE_INVITATIONS_JOB } from '../users/user-jobs';
import type { AuthTokens } from '@superapp/shared';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { authAliveKey } from '../../shared/auth/session-validator.service';

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
    private keysCascades: KeysCascadesService,
  ) {}

  async register(data: {
    phone: string;
    password: string;
    firstName: string;
    lastName?: string;
    dateOfBirth?: string; // ISO YYYY-MM-DD
    verifyToken?: string; // одноразовый пропуск движка подтверждений (purpose=register)
  }, deviceInfo?: string | null): Promise<AuthTokens> {
    // Secure-by-default (движок core/verify): в production аккаунт без подтверждённого
    // SMS-кодом номера создать нельзя — иначе возвращается дыра «занял чужой номер —
    // получил его приглашения». В development/test токен опционален (seed/verify-скрипты).
    if (this.verify.required && !data.verifyToken) {
      throw badRequest('auth.verifyRequired');
    }

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
    const hashedPassword = await bcrypt.hash(data.password, 12);

    // Create user + system role + trial subscription in one transaction
    const user = await this.db.$transaction(async (tx) => {
      // Гашение пропуска — В ТРАНЗАКЦИИ создания (откат = пропуск не потрачен).
      // expectedPhone гарантирует: подтверждён именно ТОТ номер, на который регистрируемся.
      if (data.verifyToken) {
        await this.verify.consume(tx, {
          verifyToken: data.verifyToken,
          purpose: 'register',
          expectedPhone: data.phone,
        });
      }

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
      // Аналитика: факт регистрации — в той же транзакции (откат = события нет)
      await this.analytics.track(tx, 'auth.user.registered', { verified: !!data.verifyToken }, { userId: newUser.id, workspaceId: null });

      return newUser;
    });

    // Generate tokens — system role goes into JWT
    return this.generateTokens(user.id, user.phone, 'user', user.tokenEpoch, deviceInfo);
  }

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

    if (!user) {
      throw unauthorized('auth.badCredentials');
    }

    if (user.deletedAt) {
      throw unauthorized('auth.accountDeleted');
    }
    // Бот (core/keys) — теневой пользователь: входа паролем у него нет никогда
    if (user.kind === 'bot') {
      throw unauthorized('auth.badCredentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw unauthorized('auth.badCredentials');
    }

    // Logging in during the deletion grace window cancels the pending deletion.
    // Conditional on deletedAt=null so we never "restore" (and issue tokens for)
    // an account the cron permanently anonymized between our read and now.
    let restored = false;
    if (user.deletionScheduledAt) {
      const { count } = await this.db.user.updateMany({
        where: { id: user.id, deletedAt: null },
        data: { deletionScheduledAt: null },
      });
      if (count === 0) {
        throw unauthorized('auth.accountDeleted');
      }
      await this.redis.invalidateUserProfile(user.id);
      restored = true;
    }

    // Get highest system role
    const systemRole = this.getHighestSystemRole(user.roles.map((r) => r.role));

    const tokens = await this.generateTokens(user.id, user.phone, systemRole, user.tokenEpoch, deviceInfo);
    await this.analytics.track(null, 'auth.user.logged_in', {}, { userId: user.id, workspaceId: null });
    return { ...tokens, restored };
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
    const hashedPassword = await bcrypt.hash(newPassword, 12); // CPU — до транзакции

    const { userId, phone, restored, epoch } = await this.db.$transaction(async (tx) => {
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
            select: { id: true, phone: true, deletedAt: true, deletionScheduledAt: true },
          })
        : await tx.user.findUnique({
            where: { phone: consumed.phone },
            select: { id: true, phone: true, deletedAt: true, deletionScheduledAt: true },
          });
      // Нейтральная формулировка (анти-энумерация reset-потока сохраняется).
      // Проверка phone: номер аккаунта не должен был поменяться после выдачи пропуска.
      if (!user || user.deletedAt || user.phone !== consumed.phone) {
        throw badRequest('auth.verifyStale');
      }
      await tx.user.update({
        where: { id: user.id },
        data: { password: hashedPassword, deletionScheduledAt: null },
      });
      // Все сессии — в отставку: чужие руки со старым паролем/refresh-токенами отрезаны.
      await tx.session.deleteMany({ where: { userId: user.id } });
      // …и выданные access-токены вместе с ними (иначе жили бы ещё до 15 минут).
      const epoch = await this.bumpTokenEpochTx(tx, user.id);
      await this.analytics.track(tx, 'auth.password.reset', {}, { userId: user.id, workspaceId: null });
      return { userId: user.id, phone: user.phone, restored: !!user.deletionScheduledAt, epoch };
    });

    await this.redis.delPattern(`user:${userId}:*`);
    // Кэш поколения — сразу после коммита, иначе до минуты старые токены проходят.
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    // Живые сокеты со старыми сессиями рвём немедленно (паттерн logout-all).
    this.events.emit('auth.sessions.revoked', { userId }, 'auth');
    // Уведомление — ПОСЛЕ коммита и без права уронить ответ: пароль уже сменён, а в
    // ответе едут токены автовхода. Упавшая лента не должна выглядеть как «сброс не удался».
    this.notifications
      .send(null, { type: 'auth.password.changed', to: [{ userId }], reason: 'system', actionUrl: '/profile/security' })
      .catch((err) => this.logger.error(`The password-change notification was not created: ${err.message}`));

    const roles = await this.db.userRole.findMany({
      where: { userId, context: 'system', isActive: true },
      select: { role: true },
    });
    const tokens = await this.generateTokens(
      userId,
      phone,
      this.getHighestSystemRole(roles.map((r) => r.role)),
      epoch,
      deviceInfo,
    );
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

    if (!session || session.expiresAt < new Date()) {
      throw unauthorized('auth.sessionExpired');
    }

    if (session.rotatedAt) {
      const sinceMs = Date.now() - session.rotatedAt.getTime();
      if (sinceMs > KEYS_LIMITS.refreshReuseGraceSec * 1000) {
        // Повтор вне grace: семейство отозвано целиком; уведомление — после отзыва,
        // без права уронить отказ (лента — не security-эффект)
        await this.db.session.deleteMany({ where: { familyId: session.familyId } });
        this.events.emit('auth.sessions.revoked', { userId: session.userId }, 'auth');
        this.notifications
          .send(null, { type: 'auth.session.reuseDetected', to: [{ userId: session.userId }], reason: 'system', actionUrl: '/profile/security' })
          .catch((err) => this.logger.warn(`reuse-detected notification failed: ${err.message}`));
        await this.analytics.track(null, 'keys.session.reuse_detected', {}, { userId: session.userId, workspaceId: null });
        this.logger.warn(`refresh token reuse detected: user ${session.userId}, family ${session.familyId} revoked`);
        throw unauthorized('auth.sessionExpired');
      }
      // Внутри grace: тот же клиент повторил запрос — выдаём ещё одну пару того же семейства
    }

    const systemRole = this.getHighestSystemRole(
      session.user.roles.map((r) => r.role),
    );

    // deviceInfo наследуется от ротируемой строки — иначе после первого же refresh
    // (≤15 мин) устройство в списке сессий снова становится «Неизвестным».
    const minted = await this.mintSession(
      session.user.id,
      session.user.phone,
      systemRole,
      session.user.tokenEpoch,
      session.deviceInfo,
      session.familyId,
    );
    // Прокрутка: старая строка остаётся до истечения (её предъявление = сигнал), guard по
    // rotatedAt — гонка двух refresh одним токеном помечает ровно один раз
    await this.db.session.updateMany({
      where: { id: session.id, rotatedAt: null },
      data: { rotatedAt: new Date(), replacedById: minted.sessionId },
    });
    return minted.tokens;
  }

  /** Выход — всё семейство сессии этого устройства (прокрученные строки включительно). */
  async logout(userId: string, refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const session = await this.db.session.findFirst({ where: { userId, token: tokenHash }, select: { familyId: true } });
    if (!session) return;
    await this.db.session.deleteMany({ where: { userId, familyId: session.familyId } });
  }

  async logoutAll(userId: string) {
    // Поколение токенов вперёд — иначе «выход со всех устройств» убирал только
    // refresh-строки, а выданные access-токены работали ещё до 15 минут.
    await this.db.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { userId } });
      await this.bumpTokenEpochTx(tx, userId);
    });
    // Invalidate all cached data for this user
    await this.redis.delPattern(`user:${userId}:*`);
    await this.redis.del(authAliveKey(userId)).catch(() => undefined);
    // Hard-disconnect live messenger sockets too: socket auth happens only on the
    // handshake, so without this a revoked session keeps receiving realtime traffic.
    this.events.emit('auth.sessions.revoked', { userId }, 'auth');
  }

  private getHighestSystemRole(roles: string[]): string {
    // Priority: admin > moderator > user
    if (roles.includes('admin')) return 'admin';
    if (roles.includes('moderator')) return 'moderator';
    return 'user';
  }

  /**
   * Инкремент поколения токенов = отзыв ВСЕХ ранее выданных access-токенов
   * (JwtStrategy сверяет epoch). Зовётся в транзакции действия, которое обещает
   * «все сессии завершены»; кэш «жив» чистится сразу после коммита — иначе до
   * минуты старые токены проходили бы по закэшированному поколению.
   */
  private async bumpTokenEpochTx(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const user = await tx.user.update({
      where: { id: userId },
      data: { tokenEpoch: { increment: 1 } },
      select: { tokenEpoch: true },
    });
    // «Все сессии завершены» = и личные ключи API тоже (ключ — сессия без срока)
    await this.keysCascades.onTokenEpochBump(tx, userId);
    return user.tokenEpoch;
  }

  /**
   * Чеканит тройку «access + refresh + строка session» разом. Идентификатор строки
   * генерируется ЗДЕСЬ и уезжает в payload access-токена (`sid`) — только так список
   * устройств может честно сказать «эта сессия — текущая», не пересылая refresh-токен
   * (главный секрет) на ручку листинга.
   * `deviceInfo` — User-Agent: при входе приходит из контроллера, при ротации
   * наследуется от прошлой строки, иначе список устройств навсегда остаётся
   * «Неизвестное устройство» (поле в схеме было, но не писалось НИГДЕ).
   */
  private async generateTokens(
    userId: string,
    phone: string,
    role: string,
    epoch: number,
    deviceInfo?: string | null,
  ): Promise<AuthTokens> {
    return (await this.mintSession(userId, phone, role, epoch, deviceInfo, randomUUID())).tokens;
  }

  /**
   * Сама чеканка: access `typ: at+jwt` и refresh `typ: refresh+jwt` — оба EdDSA с `kid`
   * аудитории `product` (core/keys). `familyId` — семейство refresh-цепочки одного
   * устройства: новый вход = новое семейство, ротация наследует.
   */
  private async mintSession(
    userId: string,
    phone: string,
    role: string,
    epoch: number,
    deviceInfo: string | null | undefined,
    familyId: string,
  ): Promise<{ tokens: AuthTokens; sessionId: string }> {
    const sessionId = randomUUID();
    const payload: JwtPayload = { sub: userId, phone, role, epoch, sid: sessionId };
    const accessTtl = parseDurationSec(process.env.JWT_EXPIRES_IN) ?? 15 * 60;
    const refreshTtl = parseDurationSec(process.env.JWT_REFRESH_EXPIRES_IN) ?? 30 * 86_400;

    const accessToken = await this.signing.sign('product', { ...payload }, { ttlSec: accessTtl, typ: 'at+jwt' });

    // Уникальный jti делает подписанный refresh (и его SHA-256 на unique-колонке
    // session.token) разным даже у двух входов в одну секунду (одинаковый iat).
    const refreshToken = await this.signing.sign('product', { ...payload, jti: randomUUID() }, { ttlSec: refreshTtl, typ: 'refresh+jwt' });

    const tokenHash = this.hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + refreshTtl * 1000);

    await this.db.session.create({
      data: {
        id: sessionId,
        userId,
        token: tokenHash,
        deviceInfo: deviceInfo ?? null,
        expiresAt,
        familyId,
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
