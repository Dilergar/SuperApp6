import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';

@Injectable()
export class RolesService {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
  ) {}

  /**
   * Назначить роль пользователю в контексте.
   * Например: assignRole(userId, 'staff', 'workspace', workspaceId, grantedByUserId)
   * Если роль уже есть — ничего не делает (upsert).
   */
  async assignRole(
    userId: string,
    role: string,
    context: string,
    tenantId: string | null = null,
    grantedBy: string | null = null,
  ) {
    const existing = await this.db.userRole.findFirst({
      where: { userId, role, context, tenantId },
    });

    if (existing) {
      // Reactivate if was deactivated
      if (!existing.isActive) {
        return this.db.userRole.update({
          where: { id: existing.id },
          data: { isActive: true, grantedBy },
        });
      }
      return existing;
    }

    const userRole = await this.db.userRole.create({
      data: { userId, role, context, tenantId, grantedBy },
    });

    // Invalidate cached roles
    await this.redis.del(`user:${userId}:roles`);

    return userRole;
  }

  /**
   * Отозвать роль (мягкое удаление — isActive = false).
   */
  async revokeRole(
    userId: string,
    role: string,
    context: string,
    tenantId: string | null = null,
  ) {
    await this.db.userRole.updateMany({
      where: { userId, role, context, tenantId },
      data: { isActive: false },
    });

    await this.redis.del(`user:${userId}:roles`);
  }

  /**
   * Получить все активные роли пользователя.
   */
  async getUserRoles(userId: string) {
    // Try cache
    const cached = await this.redis.getJson<Array<{
      role: string;
      context: string;
      tenantId: string | null;
    }>>(`user:${userId}:roles`);

    if (cached) return cached;

    const roles = await this.db.userRole.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        role: true,
        context: true,
        tenantId: true,
        grantedAt: true,
      },
      orderBy: { grantedAt: 'asc' },
    });

    // Cache for 5 minutes
    await this.redis.setJson(`user:${userId}:roles`, roles, 300);

    return roles;
  }

  /**
   * Получить роли пользователя в конкретном контексте.
   * Пример: getRolesInContext(userId, 'workspace', workspaceId)
   */
  async getRolesInContext(userId: string, context: string, tenantId?: string) {
    return this.db.userRole.findMany({
      where: {
        userId,
        context,
        tenantId: tenantId ?? null,
        isActive: true,
      },
      select: { role: true, tenantId: true, grantedAt: true },
    });
  }

  /**
   * Проверить, есть ли у пользователя конкретная роль.
   */
  async hasRole(
    userId: string,
    role: string,
    context: string,
    tenantId: string | null = null,
  ): Promise<boolean> {
    const count = await this.db.userRole.count({
      where: { userId, role, context, tenantId, isActive: true },
    });
    return count > 0;
  }

  /**
   * Проверить, является ли пользователь системным админом.
   */
  async isSystemAdmin(userId: string): Promise<boolean> {
    return this.hasRole(userId, 'admin', 'system', null);
  }

  /**
   * Получить всех пользователей с определённой ролью в tenant.
   * Пример: getUsersByRole('staff', 'workspace', workspaceId) — все сотрудники ресторана.
   */
  async getUsersByRole(role: string, context: string, tenantId: string) {
    return this.db.userRole.findMany({
      where: { role, context, tenantId, isActive: true },
      include: {
        user: {
          select: {
            id: true,
            phone: true,
            firstName: true,
            lastName: true,
            avatar: true,
          },
        },
      },
    });
  }

  /**
   * При найме сотрудника из Jobs Marketplace:
   * НЕ создаёт нового пользователя, просто добавляет роль с его user_id.
   */
  async hireUser(
    userId: string,
    workspaceId: string,
    role: string = 'staff',
    grantedBy: string,
  ) {
    return this.assignRole(userId, role, 'workspace', workspaceId, grantedBy);
  }

  /**
   * Уволить сотрудника — отзывает роль, но аккаунт остаётся.
   */
  async fireUser(userId: string, workspaceId: string, role: string = 'staff') {
    return this.revokeRole(userId, role, 'workspace', workspaceId);
  }
}
