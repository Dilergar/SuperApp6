import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ContactsService } from '../../modules/contacts/contacts.service';
import { WorkspacesService } from '../../modules/workspaces/workspaces.service';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';

@Injectable()
export class AuthService {
  constructor(
    private db: DatabaseService,
    private jwt: JwtService,
    private redis: RedisService,
    private contacts: ContactsService,
    private workspaces: WorkspacesService,
    private events: EventBusService,
  ) {}

  async register(data: {
    phone: string;
    password: string;
    firstName: string;
    lastName?: string;
    dateOfBirth?: string; // ISO YYYY-MM-DD
  }) {
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
      const newUser = await tx.user.create({
        data: {
          phone: data.phone,
          password: hashedPassword,
          firstName: data.firstName,
          lastName: data.lastName,
          dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
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

      return newUser;
    });

    // Activate any pending invitations that targeted this phone while it
    // was unregistered. Runs AFTER the transaction so we emit events only
    // for rows that are fully committed.
    await this.contacts.activatePendingInvitationsForNewUser(user.id, user.phone);
    await this.workspaces.activatePendingWorkspaceInvitationsForNewUser(
      user.id,
      user.phone,
    );

    // Generate tokens — system role goes into JWT
    return this.generateTokens(user.id, user.phone, 'user');
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

    const tokens = await this.generateTokens(user.id, user.phone, systemRole);
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

    return this.generateTokens(session.user.id, session.user.phone, systemRole);
  }

  async logout(userId: string, refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.db.session.deleteMany({
      where: { userId, token: tokenHash },
    });
  }

  async logoutAll(userId: string) {
    await this.db.session.deleteMany({ where: { userId } });
    // Invalidate all cached data for this user
    await this.redis.delPattern(`user:${userId}:*`);
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

  private async generateTokens(userId: string, phone: string, role: string) {
    const payload: JwtPayload = { sub: userId, phone, role };

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
