import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';

@Injectable()
export class UsersService {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
  ) {}

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
        avatar: true,
        isVerified: true,
        locale: true,
        timezone: true,
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
        _count: {
          select: {
            ownedCircles: true,
            workspaceMembers: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    const profile = {
      ...user,
      circlesCount: user._count.ownedCircles,
      workspacesCount: user._count.workspaceMembers,
      activeSubscription: user.subscription,
      _count: undefined,
      subscription: undefined,
    };

    // Cache for 5 minutes
    await this.redis.setJson(`user:${userId}:profile`, profile, 300);

    return profile;
  }

  async updateProfile(
    userId: string,
    data: { firstName?: string; lastName?: string; avatar?: string; locale?: string; timezone?: string },
  ) {
    const user = await this.db.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        avatar: true,
        locale: true,
        timezone: true,
      },
    });

    // Invalidate cache
    await this.redis.del(`user:${userId}:profile`);

    return user;
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
}
