import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { resolveCardVisibility, type CardVisibility } from '@superapp/shared';

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
        dateOfBirth: true,
        avatar: true,
        isVerified: true,
        locale: true,
        timezone: true,
        cardVisibility: true,
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
            workspaceMembers: true,
            contactLinksA: true,
            contactLinksB: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    const { _count, subscription, cardVisibility, dateOfBirth, ...rest } = user;

    const profile = {
      ...rest,
      dateOfBirth: dateOfBirth ? dateOfBirth.toISOString().slice(0, 10) : null,
      cardVisibility: resolveCardVisibility(
        cardVisibility as Partial<CardVisibility> | null,
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

  async updateProfile(
    userId: string,
    data: {
      firstName?: string;
      lastName?: string | null;
      dateOfBirth?: string | null;
      avatar?: string | null;
      locale?: string;
      timezone?: string;
      cardVisibility?: Partial<CardVisibility> | null;
    },
  ) {
    const { dateOfBirth, cardVisibility, ...rest } = data;
    const user = await this.db.user.update({
      where: { id: userId },
      data: {
        ...rest,
        ...(dateOfBirth !== undefined && {
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        }),
        ...(cardVisibility !== undefined && {
          cardVisibility: cardVisibility as any,
        }),
      },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        avatar: true,
        locale: true,
        timezone: true,
      },
    });

    // Invalidate cache
    await this.redis.del(`user:${userId}:profile`);

    return {
      ...user,
      dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
    };
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
