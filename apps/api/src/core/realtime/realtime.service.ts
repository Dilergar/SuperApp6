import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/** Прямая доставка в личные комнаты — для эффектов, которым не нужна шина. */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  emitToUsers(userIds: string[], name: string, payload: unknown): void {
    if (!userIds.length) return;
    this.gateway.emitRaw([...new Set(userIds)].map((id) => `user:${id}`), name, payload);
  }

  emitToRooms(rooms: string[], name: string, payload: unknown): void {
    this.gateway.emitRaw(rooms, name, payload);
  }
}
