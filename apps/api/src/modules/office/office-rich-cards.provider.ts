import { Injectable, OnModuleInit } from '@nestjs/common';
import type { RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { OFFICE_CALL_REF_TYPE } from './office.service';

/**
 * Rich card «Встреча» (Принцип 3): title + статус («Идёт сейчас · N» / «Встреча» /
 * «Завершена»), кнопка «Присоединиться» = href на страницу встречи (action-ключей нет —
 * вход требует prejoin с выбором устройств). Видимость: участник встречи (office_room.view)
 * ∥ член команды воркспейса (карточкой делятся с коллегами, ещё не участниками; Подрядчик
 * отсечён). Читает call_sessions движка напрямую (carve-out, как офис-сервис).
 */
@Injectable()
export class OfficeRichCardsProvider implements OnModuleInit {
  constructor(private readonly registry: RichCardRegistry) {}

  onModuleInit() {
    this.registry.registerRenderer('office_room', (deps, viewerId, refId) =>
      this.render(deps, viewerId, refId),
    );
  }

  private async render(
    deps: RichCardDeps,
    viewerId: string,
    refId: string,
  ): Promise<RichCardPayload | null> {
    const room = await deps.db.officeRoom.findUnique({
      where: { id: refId },
      select: { name: true, status: true, workspaceId: true },
    });
    if (!room) return null;

    const isParticipant = await deps.access.can(
      { type: 'user', id: viewerId },
      'office_room.view',
      refId,
    );
    if (!isParticipant) {
      const roleRows = await deps.db.userRole.findMany({
        where: { userId: viewerId, context: 'workspace', tenantId: room.workspaceId, isActive: true },
        select: { role: true },
      });
      const isTeam = roleRows.some((r) => r.role !== 'contractor');
      if (!isTeam) return null;
    }

    let status = 'Встреча';
    if (room.status === 'ended') {
      status = 'Завершена';
    } else {
      const session = await deps.db.callSession.findFirst({
        where: { refType: OFFICE_CALL_REF_TYPE, refId, status: 'active' },
        select: { id: true },
      });
      if (session) {
        const count = await deps.db.callSessionParticipant.count({
          where: { sessionId: session.id, leftAt: null },
        });
        status = `Идёт сейчас · ${count}`;
      }
    }

    return {
      kind: 'rich_card',
      cardType: 'office_room',
      ref: { type: 'office_room', id: refId },
      title: room.name,
      subtitle: status,
      icon: '🎥',
      imageUrl: null,
      fields: [],
      progress: null,
      status,
      actions: [],
      href: `/workspaces/${room.workspaceId}/office/${refId}`,
    };
  }
}
