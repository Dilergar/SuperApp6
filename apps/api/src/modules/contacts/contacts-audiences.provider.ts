import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { AudiencesRegistry } from '../../core/audiences/audiences.registry';
import { ContactsService } from './contacts.service';

/**
 * Регистрация Группы (Circle) как адресата в core/audiences. Разворот — ТОЛЬКО через
 * `ContactsService.resolveCircleMemberIds` (единственный законный разворот Группы;
 * `gate: false` — системный путь: адресация, не действие «между людьми»).
 * Группа принадлежит человеку, поэтому чужая Группа → пусто, а не чужие люди.
 */
@Injectable()
export class ContactsAudiencesProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly contacts: ContactsService,
    private readonly audiences: AudiencesRegistry,
  ) {}

  onModuleInit(): void {
    this.audiences.register('circle', {
      resolve: async (circleId, ctx, limit) => {
        const circle = await this.db.circle.findUnique({ where: { id: circleId }, select: { ownerId: true } });
        if (!circle) return [];
        const owner = ctx.selfId ?? ctx.initiatorId ?? null;
        if (owner && owner !== circle.ownerId) return [];
        const ids = await this.contacts.resolveCircleMemberIds(circle.ownerId, circleId, { gate: false });
        return ids.slice(0, limit);
      },
      label: async (circleId) => {
        const c = await this.db.circle.findUnique({ where: { id: circleId }, select: { name: true } });
        return c ? `Группа «${c.name}»` : null;
      },
    });
  }
}
