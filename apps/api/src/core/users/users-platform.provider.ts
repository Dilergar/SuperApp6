import { Injectable, OnModuleInit } from '@nestjs/common';
import { maskIdNumber, maskPhoneForConsole, type PlatformUserHitDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { PlatformLookupRegistry, PlatformPanelRegistry } from '../platform/platform-lookup.registry';

/**
 * Люди в кабинете платформы: поиск (полный телефон, ИИН, uuid, имя) и панель профиля
 * с БЕЛЫМ списком полей (S11): ни хэшей паролей, ни токенов, ни полного ИИН/телефона —
 * они замаскированы, раскрытие — командой `platform.pii.reveal`.
 */
@Injectable()
export class UsersPlatformProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly lookup: PlatformLookupRegistry,
    private readonly panels: PlatformPanelRegistry,
  ) {}

  onModuleInit(): void {
    this.lookup.register({
      entity: 'user',
      match: async (query, limit) => {
        if (query.kind === 'phone') {
          const u = await this.db.user.findUnique({ where: { phone: query.value }, select: { id: true } });
          const hit = u ? await this.header(u.id) : null;
          return hit ? [hit] : [];
        }
        if (query.kind === 'uuid') {
          const hit = await this.header(query.value);
          return hit ? [hit] : [];
        }
        if (query.kind === 'idNumber') {
          const rows = await this.db.user.findMany({ where: { iin: query.value }, select: { id: true }, take: limit });
          return (await Promise.all(rows.map((r) => this.header(r.id)))).filter((h): h is PlatformUserHitDto => !!h);
        }
        if (query.kind === 'text') {
          const [first, ...rest] = query.value.split(/\s+/);
          const last = rest.join(' ');
          const rows = await this.db.user.findMany({
            where: last
              ? { AND: [{ firstName: { contains: first, mode: 'insensitive' } }, { lastName: { contains: last, mode: 'insensitive' } }] }
              : { OR: [{ firstName: { contains: first, mode: 'insensitive' } }, { lastName: { contains: first, mode: 'insensitive' } }] },
            select: { id: true },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return (await Promise.all(rows.map((r) => this.header(r.id)))).filter((h): h is PlatformUserHitDto => !!h);
        }
        return [];
      },
      header: (id) => this.header(id),
    });

    this.panels.register({
      key: 'user.profile',
      entity: 'user',
      titleKey: 'platform.panels.userProfile',
      capability: 'platform.lookup.read',
      order: 10,
      eager: true,
      load: async (_actor, id) => {
        const u = await this.db.user.findUnique({
          where: { id },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            middleName: true,
            avatar: true,
            phone: true,
            email: true,
            city: true,
            iin: true,
            locale: true,
            timezone: true,
            phoneVerifiedAt: true,
            createdAt: true,
            deletionScheduledAt: true,
            deletedAt: true,
            _count: { select: { ownedCircles: true, workspaceMembers: true, sessions: true } },
          },
        });
        if (!u) return null;
        return {
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          middleName: u.middleName,
          avatar: u.avatar,
          phoneMasked: maskPhoneForConsole(u.phone),
          emailMasked: u.email ? `${u.email.slice(0, 2)}•••@${u.email.split('@')[1] ?? ''}` : null,
          city: u.city,
          iinMasked: maskIdNumber(u.iin),
          locale: u.locale,
          timezone: u.timezone,
          phoneVerifiedAt: u.phoneVerifiedAt?.toISOString() ?? null,
          createdAt: u.createdAt.toISOString(),
          deletionScheduledAt: u.deletionScheduledAt?.toISOString() ?? null,
          deletedAt: u.deletedAt?.toISOString() ?? null,
          counts: { circles: u._count.ownedCircles, workspaces: u._count.workspaceMembers, sessions: u._count.sessions },
        };
      },
    });
  }

  private async header(id: string): Promise<PlatformUserHitDto | null> {
    const u = await this.db.user.findUnique({ where: { id }, select: { id: true, firstName: true, lastName: true, avatar: true, phone: true, deletedAt: true } });
    if (!u) return null;
    const staff = await this.db.platformStaff.findUnique({ where: { userId: id }, select: { status: true } });
    return {
      entity: 'user',
      id: u.id,
      person: { id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar },
      phoneMasked: u.deletedAt ? null : maskPhoneForConsole(u.phone),
      isStaff: staff?.status === 'active',
      deletedAt: u.deletedAt?.toISOString() ?? null,
    };
  }
}
