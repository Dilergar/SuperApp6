import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { DatabaseService } from '../../shared/database/database.service';
import { MessengerService } from './messenger.service';

/**
 * Bridges office-room lifecycle + call-session events onto the meeting's CONTEXT chat
 * as system plaques. Best-effort — a failure here never affects the office/call operation.
 *
 *  - office.room.created: eager-чат + плашка «<имя> создал(а) встречу».
 *  - office.room.invited: resync + sync members + плашка «<имя> пригласил(а) участников».
 *  - office.room.ended: плашка «Встреча завершена» (чат живёт — история переписки).
 *  - call.session.started|ended с payload.refType='office_room' (фильтр по payload —
 *    чужие звонки будущих потребителей движка не наши): плашки «Звонок начался/завершён».
 *    Пер-участник (joined/left) плашек НЕТ осознанно — на живой встрече это спам,
 *    участники и так видны в комнате.
 */
@Injectable()
export class OfficeSystemListener implements OnModuleInit {
  private readonly logger = new Logger(OfficeSystemListener.name);

  constructor(
    private readonly events: EventBusService,
    private readonly projection: AccessProjectionService,
    private readonly db: DatabaseService,
    private readonly messenger: MessengerService,
  ) {}

  onModuleInit() {
    this.events.onPattern('office.room.*').subscribe((e) => {
      void this.handleRoom(e.type, (e.payload ?? {}) as OfficeEventPayload);
    });
    this.events.onPattern('call.session.*').subscribe((e) => {
      void this.handleCall(e.type, (e.payload ?? {}) as OfficeEventPayload);
    });
  }

  private async handleRoom(type: string, p: OfficeEventPayload): Promise<void> {
    try {
      const roomId = p.roomId;
      if (!roomId) return;
      await this.projection.resyncOfficeRoomRoles(roomId); // идемпотентная подстраховка

      if (type === 'office.room.created') {
        const who = (await this.nameOf(p.byUserId)) ?? 'Кто-то';
        await this.messenger.postOfficeRoomSystemMessage(roomId, type, `${who} создал(а) встречу`);
        return;
      }
      if (type === 'office.room.invited') {
        await this.messenger.syncOfficeRoomChatMembers(roomId);
        const who = (await this.nameOf(p.byUserId)) ?? 'Кто-то';
        await this.messenger.postOfficeRoomSystemMessage(roomId, type, `${who} пригласил(а) участников`);
        return;
      }
      if (type === 'office.room.ended') {
        // Плашка только в существующий чат — не создаём чат ради объявления о конце
        if (!(await this.chatExists(roomId))) return;
        await this.messenger.postOfficeRoomSystemMessage(roomId, type, 'Встреча завершена');
        return;
      }
    } catch (err) {
      this.logger.warn(
        `office system message failed (non-fatal): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  private async handleCall(type: string, p: OfficeEventPayload): Promise<void> {
    try {
      if (p.refType !== 'office_room' || !p.refId) return; // фильтр по payload — без запросов в БД
      const roomId = p.refId;
      if (type === 'call.session.started') {
        await this.projection.resyncOfficeRoomRoles(roomId);
        await this.messenger.postOfficeRoomSystemMessage(roomId, type, 'Звонок начался');
        return;
      }
      if (type === 'call.session.ended') {
        if (!(await this.chatExists(roomId))) return;
        await this.messenger.postOfficeRoomSystemMessage(roomId, type, 'Звонок завершён');
        return;
      }
    } catch (err) {
      this.logger.warn(
        `office call plaque failed (non-fatal): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  private async chatExists(roomId: string): Promise<boolean> {
    const chat = await this.db.chat.findFirst({
      where: { parentType: 'office_room', parentId: roomId },
      select: { id: true },
    });
    return !!chat;
  }

  private async nameOf(userId?: string): Promise<string | null> {
    if (!userId) return null;
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    if (!u) return null;
    return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.firstName;
  }
}

interface OfficeEventPayload {
  roomId?: string;
  workspaceId?: string;
  byUserId?: string;
  userIds?: string[];
  refType?: string;
  refId?: string;
  userId?: string;
  reason?: string;
  [key: string]: unknown;
}
