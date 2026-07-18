import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { authAliveKey } from '../auth/jwt.strategy';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessProjectionService } from '../access/access-projection.service';
import { FilesService } from '../files/files.service';
import { resolveCardVisibility, type UpdateProfileInput } from '@superapp/shared';

/** Days a deleted account stays recoverable before permanent anonymization. */
export const ACCOUNT_GRACE_DAYS = 30;

@Injectable()
export class UsersService {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private events: EventBusService,
    private accessProjection: AccessProjectionService,
    private files: FilesService,
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
        bio: true,
        city: true,
        email: true,
        maritalStatus: true,
        socialLinks: true,
        onlineStatusMode: true,
        isVerified: true,
        locale: true,
        timezone: true,
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

    const { _count, subscription, cardVisibility, companyCardVisibility, dateOfBirth, ...rest } = user;

    const profile = {
      ...rest,
      dateOfBirth: dateOfBirth ? dateOfBirth.toISOString().slice(0, 10) : null,
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
        ...(companyCardVisibility !== undefined && {
          companyCardVisibility: companyCardVisibility as any,
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
