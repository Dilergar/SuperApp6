import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { ContactsService } from '../../modules/contacts/contacts.service';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';

@Injectable()
export class AuthService {
  constructor(
    private db: DatabaseService,
    private jwt: JwtService,
    private redis: RedisService,
    private contacts: ContactsService,
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

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Неверный номер телефона или пароль');
    }

    // Get highest system role
    const systemRole = this.getHighestSystemRole(user.roles.map((r) => r.role));

    return this.generateTokens(user.id, user.phone, systemRole);
  }

  async refreshToken(refreshToken: string) {
    // Find session by refresh token hash
    const tokenHash = await this.hashToken(refreshToken);
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
    const tokenHash = await this.hashToken(refreshToken);
    await this.db.session.deleteMany({
      where: { userId, token: tokenHash },
    });
  }

  async logoutAll(userId: string) {
    await this.db.session.deleteMany({ where: { userId } });
    // Invalidate all cached data for this user
    await this.redis.delPattern(`user:${userId}:*`);
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

    // Generate refresh token
    const refreshToken =
      this.jwt.sign(payload, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });

    // Store refresh token hash in DB
    const tokenHash = await this.hashToken(refreshToken);
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

  private async hashToken(token: string): Promise<string> {
    return bcrypt.hash(token, 4); // Light hash for lookups
  }
}
