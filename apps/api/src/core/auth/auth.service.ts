import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
// Нативный bcrypt (libuv threadpool): bcryptjs считал cost-12 хэш НА event-loop'е
// (~0.5–1.5с CPU) — десяток одновременных логинов душил все запросы инстанса.
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { VerifyService } from '../verify/verify.service';
import { JobsService } from '../jobs/jobs.service';
import { USER_PHONE_INVITATIONS_JOB } from '../users/user-jobs';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { authAliveKey } from '../../shared/auth/session-validator.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private db: DatabaseService,
    private jwt: JwtService,
    private redis: RedisService,
    private events: EventBusService,
    private notifications: NotificationsService,
    private verify: VerifyService,
    private jobs: JobsService,
  ) {}

  async register(data: {
    phone: string;
    password: string;
    firstName: string;
    lastName?: string;
    dateOfBirth?: string; // ISO YYYY-MM-DD
    verifyToken?: string; // одноразовый пропуск движка подтверждений (purpose=register)
  }) {
    // Secure-by-default (движок core/verify): в production аккаунт без подтверждённого
    // SMS-кодом номера создать нельзя — иначе возвращается дыра «занял чужой номер —
    // получил его приглашения». В development/test токен опционален (seed/verify-скрипты).
    if (this.verify.required && !data.verifyToken) {
      throw new BadRequestException('Требуется подтверждение номера по SMS');
    }

    // Check if phone already exists
    const existing = await this.db.user.findUnique({
      where: { phone: data.phone },
    });

    if (existing) {
      if (existing.deletionScheduledAt && !existing.deletedAt) {
        throw new ConflictException(
          'Этот номер привязан к аккаунту, помеченному на удаление. Войдите, чтобы восстановить его.',
        );
      }
      throw new ConflictException('Этот номер телефона уже зарегистрирован');
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

      // Create default subscription (3 month trial)
      const trialEnd = new Date();
      trialEnd.setMonth(trialEnd.getMonth() + 3);

      await tx.subscription.create({
        data: {
          userId: newUser.id,
          plan: 'free',
          status: 'trial',
          expiresAt: trialEnd,
        },
      });

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

      return newUser;
    });

    // Generate tokens — system role goes into JWT
    return this.generateTokens(user.id, user.phone, 'user', user.tokenEpoch);
  }

  async login(phone: string, password: string) {
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
      throw new UnauthorizedException('Неверный номер телефона или пароль');
    }

    if (user.deletedAt) {
      throw new UnauthorizedException('Аккаунт удалён');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Неверный номер телефона или пароль');
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
        throw new UnauthorizedException('Аккаунт удалён');
      }
      await this.redis.invalidateUserProfile(user.id);
      restored = true;
    }

    // Get highest system role
    const systemRole = this.getHighestSystemRole(user.roles.map((r) => r.role));

    const tokens = await this.generateTokens(user.id, user.phone, systemRole, user.tokenEpoch);
    return { ...tokens, restored };
  }

  /**
   * Завершение «Забыли пароль?» (движок core/verify, purpose=password_reset):
   * verifyToken доказывает владение номером → смена пароля + отзыв ВСЕХ сессий +
   * уведомление + АВТОВХОД (решение продукта: человек только что подтвердил номер
   * и задал пароль — заставлять вводить его снова через 3 секунды бессмысленно).
   * Аккаунт в грейс-периоде удаления восстанавливается (симметрия с login).
   */
  async resetPassword(verifyToken: string, newPassword: string) {
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
        throw new BadRequestException('Подтверждение недействительно или устарело. Запросите код заново');
      }
      await tx.user.update({
        where: { id: user.id },
        data: { password: hashedPassword, deletionScheduledAt: null },
      });
      // Все сессии — в отставку: чужие руки со старым паролем/refresh-токенами отрезаны.
      await tx.session.deleteMany({ where: { userId: user.id } });
      // …и выданные access-токены вместе с ними (иначе жили бы ещё до 15 минут).
      const epoch = await this.bumpTokenEpochTx(tx, user.id);
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
      .notify(userId, 'auth.password.changed', {})
      .catch((err) => this.logger.error(`Уведомление о смене пароля не создано: ${err.message}`));

    const roles = await this.db.userRole.findMany({
      where: { userId, context: 'system', isActive: true },
      select: { role: true },
    });
    const tokens = await this.generateTokens(
      userId,
      phone,
      this.getHighestSystemRole(roles.map((r) => r.role)),
      epoch,
    );
    return { ...tokens, restored };
  }

  async refreshToken(refreshToken: string) {
    // Find session by refresh token hash
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
      throw new UnauthorizedException('Сессия истекла, войдите снова');
    }

    // Rotate refresh token (security best practice)
    await this.db.session.delete({ where: { id: session.id } });

    const systemRole = this.getHighestSystemRole(
      session.user.roles.map((r) => r.role),
    );

    return this.generateTokens(session.user.id, session.user.phone, systemRole, session.user.tokenEpoch);
  }

  async logout(userId: string, refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.db.session.deleteMany({
      where: { userId, token: tokenHash },
    });
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
    return user.tokenEpoch;
  }

  private async generateTokens(userId: string, phone: string, role: string, epoch: number) {
    const payload: JwtPayload = { sub: userId, phone, role, epoch };

    const accessToken = this.jwt.sign(payload);

    // Generate refresh token. A unique jti makes the signed token (and thus its
    // SHA-256 hash on the unique session.token column) distinct even for two
    // logins in the same second (identical iat) — avoids a duplicate-key crash.
    const refreshToken = this.jwt.sign(
      { ...payload, jti: randomUUID() },
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' },
    );

    // Store refresh token hash in DB
    const tokenHash = this.hashToken(refreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await this.db.session.create({
      data: {
        userId,
        token: tokenHash,
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes in seconds
    };
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
