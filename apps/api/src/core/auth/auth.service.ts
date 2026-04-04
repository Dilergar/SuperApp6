import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';

@Injectable()
export class AuthService {
  constructor(
    private db: DatabaseService,
    private jwt: JwtService,
    private redis: RedisService,
  ) {}

  async register(data: {
    phone: string;
    password: string;
    firstName: string;
    lastName?: string;
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

    // Create user
    const user = await this.db.user.create({
      data: {
        phone: data.phone,
        password: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName,
      },
    });

    // Create default subscription (3 month trial)
    const trialEnd = new Date();
    trialEnd.setMonth(trialEnd.getMonth() + 3);

    await this.db.subscription.create({
      data: {
        userId: user.id,
        plan: 'free',
        status: 'trial',
        expiresAt: trialEnd,
      },
    });

    // Generate tokens
    return this.generateTokens(user.id, user.phone, user.systemRole);
  }

  async login(phone: string, password: string) {
    const user = await this.db.user.findUnique({
      where: { phone },
    });

    if (!user) {
      throw new UnauthorizedException('Неверный номер телефона или пароль');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Неверный номер телефона или пароль');
    }

    return this.generateTokens(user.id, user.phone, user.systemRole);
  }

  async refreshToken(refreshToken: string) {
    // Find session by refresh token hash
    const tokenHash = await this.hashToken(refreshToken);
    const session = await this.db.session.findUnique({
      where: { token: tokenHash },
      include: { user: true },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Сессия истекла, войдите снова');
    }

    // Rotate refresh token (security best practice)
    await this.db.session.delete({ where: { id: session.id } });

    return this.generateTokens(
      session.user.id,
      session.user.phone,
      session.user.systemRole,
    );
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
