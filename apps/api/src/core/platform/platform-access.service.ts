import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import {
  PLATFORM_ERROR_CODES,
  PLATFORM_ROLES,
  capabilitiesOfRoles,
  isOwnerRole,
  isPlatformRoleKey,
  sodConflicts,
  type PlatformCapability,
  type PlatformPersonDto,
  type PlatformRoleKey,
  type PlatformStaffAddInput,
  type PlatformStaffDto,
  type PlatformStaffRoleGrantInput,
  type PlatformStaffStatus,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { PLATFORM_CAPS_TTL_SEC, PLATFORM_REDIS } from './platform.constants';
import { DI_TOKENS } from '../../shared/di-tokens';
import type { AuditService } from '../audit/audit.service';

type Tx = Prisma.TransactionClient;

export interface StaffAccess {
  status: PlatformStaffStatus | null;
  roles: PlatformRoleKey[];
  capabilities: PlatformCapability[];
}

const PERSON_SELECT = { id: true, firstName: true, lastName: true, avatar: true } as const;

/**
 * Сотрудники платформы и их права. Источник правды — `PlatformStaff` / `PlatformStaffRole`;
 * `user_roles` продукта НЕ читаются никогда. Кэш capabilities — Redis 60 с, сброс при
 * любой правке ролей/статуса.
 */
@Injectable()
export class PlatformAccessService {
  private readonly logger = new Logger(PlatformAccessService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Журнал безопасности — лениво (core/audit тянет реестры Кабинета: прямая инъекция = цикл). */
  private get audit(): AuditService {
    return this.moduleRef.get<AuditService>(DI_TOKENS.AuditService, { strict: false });
  }

  async accessOf(userId: string): Promise<StaffAccess> {
    const key = PLATFORM_REDIS.caps(userId);
    try {
      const cached = await this.redis.get(key);
      if (cached) return JSON.parse(cached) as StaffAccess;
    } catch {
      /* кэш — best-effort */
    }
    const access = await this.loadAccess(userId);
    try {
      await this.redis.set(key, JSON.stringify(access), PLATFORM_CAPS_TTL_SEC);
    } catch {
      /* best-effort */
    }
    return access;
  }

  private async loadAccess(userId: string, tx: Tx | DatabaseService = this.db): Promise<StaffAccess> {
    const staff = await tx.platformStaff.findUnique({ where: { userId }, include: { roles: true } });
    if (!staff) return { status: null, roles: [], capabilities: [] };
    const now = Date.now();
    const roles = staff.roles
      .filter((r) => !r.expiresAt || r.expiresAt.getTime() > now)
      .map((r) => r.role)
      .filter(isPlatformRoleKey);
    return {
      status: staff.status as PlatformStaffStatus,
      roles,
      capabilities: staff.status === 'active' ? capabilitiesOfRoles(roles) : [],
    };
  }

  async can(userId: string, cap: PlatformCapability): Promise<boolean> {
    return (await this.accessOf(userId)).capabilities.includes(cap);
  }

  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(PLATFORM_REDIS.caps(userId));
    } catch {
      /* best-effort */
    }
  }

  /** Держатели права (для адресатов заявок four-eyes и security-alert). */
  async holdersOf(cap: PlatformCapability, opts: { exclude?: string } = {}): Promise<string[]> {
    const rows = await this.db.platformStaff.findMany({ where: { status: 'active' }, include: { roles: true } });
    const now = Date.now();
    const out: string[] = [];
    for (const s of rows) {
      if (opts.exclude && s.userId === opts.exclude) continue;
      const roles = s.roles.filter((r) => !r.expiresAt || r.expiresAt.getTime() > now).map((r) => r.role).filter(isPlatformRoleKey);
      if (capabilitiesOfRoles(roles).includes(cap)) out.push(s.userId);
    }
    return out;
  }

  async ownerIds(): Promise<string[]> {
    const rows = await this.db.platformStaffRole.findMany({
      where: { staff: { status: 'active' }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { userId: true, role: true },
    });
    return [...new Set(rows.filter((r) => isPlatformRoleKey(r.role) && isOwnerRole(r.role)).map((r) => r.userId))];
  }

  // ============================================================
  // Чтение
  // ============================================================

  async listStaff(): Promise<PlatformStaffDto[]> {
    const rows = await this.db.platformStaff.findMany({ include: { roles: { orderBy: { grantedAt: 'asc' } } }, orderBy: { createdAt: 'asc' } });
    const people = await this.peopleOf(rows.map((r) => r.userId));
    return rows.map((r) => this.toStaffDto(r, people.get(r.userId)));
  }

  async staffOf(userId: string): Promise<PlatformStaffDto | null> {
    const row = await this.db.platformStaff.findUnique({ where: { userId }, include: { roles: { orderBy: { grantedAt: 'asc' } } } });
    if (!row) return null;
    const people = await this.peopleOf([userId]);
    return this.toStaffDto(row, people.get(userId));
  }

  async peopleOf(userIds: string[]): Promise<Map<string, PlatformPersonDto>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return new Map();
    const users = await this.db.user.findMany({ where: { id: { in: ids } }, select: PERSON_SELECT });
    return new Map(users.map((u) => [u.id, { id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar }]));
  }

  private toStaffDto(row: Prisma.PlatformStaffGetPayload<{ include: { roles: true } }>, person?: PlatformPersonDto): PlatformStaffDto {
    return {
      userId: row.userId,
      person: person ?? { id: row.userId, firstName: '', lastName: null, avatar: null },
      status: row.status as PlatformStaffStatus,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      roles: row.roles
        .filter((r): r is typeof r & { role: PlatformRoleKey } => isPlatformRoleKey(r.role))
        .map((r) => ({
          role: r.role,
          scope: { kind: 'global' as const },
          grantedBy: r.grantedBy,
          grantedAt: r.grantedAt.toISOString(),
          expiresAt: r.expiresAt?.toISOString() ?? null,
          reason: r.reason,
        })),
    };
  }

  // ============================================================
  // Мутации (только из команд реестра; права проверил исполнитель)
  // ============================================================

  private assertNotSelf(actorId: string, userId: string): void {
    if (actorId === userId) throw forbidden('platform.self_target', undefined, { code: PLATFORM_ERROR_CODES.selfTarget });
  }

  async addStaff(tx: Tx, actorId: string, input: PlatformStaffAddInput, reason: string): Promise<PlatformStaffDto> {
    this.assertNotSelf(actorId, input.userId);
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, deletedAt: true } });
    if (!user || user.deletedAt) throw notFound('platform.user_not_found');
    const existing = await tx.platformStaff.findUnique({ where: { userId: input.userId } });
    if (existing) throw conflict('platform.staff_exists');
    await tx.platformStaff.create({ data: { userId: input.userId, status: 'active', note: input.note ?? null, createdBy: actorId } });
    if (input.role) await this.grantRole(tx, actorId, { userId: input.userId, role: input.role, expiresAt: null }, reason);
    await this.invalidate(input.userId);
    return (await this.staffOfTx(tx, input.userId))!;
  }

  async suspendStaff(tx: Tx, actorId: string, userId: string): Promise<{ before: PlatformStaffDto; after: PlatformStaffDto }> {
    this.assertNotSelf(actorId, userId);
    const before = await this.staffOfTx(tx, userId);
    if (!before) throw notFound('platform.staff_not_found');
    if (before.status === 'active' && before.roles.some((r) => isOwnerRole(r.role))) await this.assertNotLastOwner(tx, userId);
    await tx.platformStaff.updateMany({ where: { userId, status: 'active' }, data: { status: 'suspended', suspendedAt: new Date() } });
    // Отзыв ВСЕХ сессий кабинета приостановленного (S3)
    await tx.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.invalidate(userId);
    return { before, after: (await this.staffOfTx(tx, userId))! };
  }

  async grantRole(tx: Tx, actorId: string, input: PlatformStaffRoleGrantInput, reason: string): Promise<PlatformStaffDto> {
    this.assertNotSelf(actorId, input.userId);
    const staff = await tx.platformStaff.findUnique({ where: { userId: input.userId }, include: { roles: true } });
    if (!staff) throw notFound('platform.staff_not_found');
    if (staff.roles.some((r) => r.role === input.role)) throw conflict('platform.role_exists');
    // SoD: набор ролей после выдачи не должен держать write+approve одной пары (S8)
    const nextRoles = [...staff.roles.map((r) => r.role).filter(isPlatformRoleKey), input.role];
    const exempt = nextRoles.every((r) => !!PLATFORM_ROLES[r].sodExempt);
    if (!exempt) {
      const conflicts = sodConflicts(capabilitiesOfRoles(nextRoles));
      if (conflicts.length) {
        throw conflict('platform.sod_conflict', { object: conflicts[0][0].replace(/\.write$/, '') }, { code: PLATFORM_ERROR_CODES.sodConflict, conflicts });
      }
    }
    await tx.platformStaffRole.create({
      data: {
        userId: input.userId,
        role: input.role,
        grantedBy: actorId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        reason,
      },
    });
    await this.invalidate(input.userId);
    return (await this.staffOfTx(tx, input.userId))!;
  }

  async revokeRole(tx: Tx, actorId: string, userId: string, role: PlatformRoleKey): Promise<{ before: PlatformStaffDto; after: PlatformStaffDto }> {
    this.assertNotSelf(actorId, userId);
    const before = await this.staffOfTx(tx, userId);
    if (!before) throw notFound('platform.staff_not_found');
    if (!before.roles.some((r) => r.role === role)) throw notFound('platform.role_not_found');
    if (isOwnerRole(role) && before.status === 'active') await this.assertNotLastOwner(tx, userId);
    await tx.platformStaffRole.deleteMany({ where: { userId, role } });
    await this.invalidate(userId);
    return { before, after: (await this.staffOfTx(tx, userId))! };
  }

  /** Последнего активного владельца лишить нельзя — иначе кабинет теряет управление (S8). */
  private async assertNotLastOwner(tx: Tx, userId: string): Promise<void> {
    const others = await tx.platformStaffRole.count({
      where: {
        userId: { not: userId },
        role: { in: Object.keys(PLATFORM_ROLES).filter((k) => isOwnerRole(k as PlatformRoleKey)) },
        staff: { status: 'active' },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (others === 0) throw conflict('platform.last_owner', undefined, { code: PLATFORM_ERROR_CODES.lastOwner });
  }

  /**
   * Системное снятие со штата: аккаунт человека анонимизирован (терминальное удаление).
   * Прав НЕ проверяет — вызывающий это сделал (правило `system*`-методов). Последнего
   * владельца здесь не защищаем: аккаунта уже нет, и «нельзя» ничего бы не изменило —
   * зато молчаливо оставленный активным сотрудник остался бы адресатом заявок и
   * получателем security-alert на мёртвый профиль.
   *
   * Событие журнала безопасности `platform.staff.suspended_by_system` пишется здесь же и тем
   * же `tx` (актор — система: действие не сотрудника).
   */
  async systemSuspendDeletedUser(tx: Tx, userId: string): Promise<boolean> {
    const suspended = await tx.platformStaff.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'suspended', suspendedAt: new Date() },
    });
    const sessions = await tx.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (suspended.count === 0 && sessions.count === 0) return false;
    await this.audit.record(tx, {
      key: 'platform.staff.suspended_by_system',
      op: 'platform.staff.suspend',
      actor: { kind: 'system' },
      target: { type: 'user', id: userId },
      reasonCode: 'account_anonymized',
      details: { reason: 'account_anonymized' },
    });
    await this.invalidate(userId);
    return true;
  }

  private async staffOfTx(tx: Tx, userId: string): Promise<PlatformStaffDto | null> {
    const row = await tx.platformStaff.findUnique({ where: { userId }, include: { roles: { orderBy: { grantedAt: 'asc' } } } });
    if (!row) return null;
    const u = await tx.user.findUnique({ where: { id: userId }, select: PERSON_SELECT });
    return this.toStaffDto(row, u ? { id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar } : undefined);
  }
}
