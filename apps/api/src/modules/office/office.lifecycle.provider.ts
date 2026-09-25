import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../../core/lifecycle/lifecycle.purge.registry';

/**
 * Виртуальный офис в движке сроков core/lifecycle: участие человека во встрече
 * (`OfficeRoomParticipant`) стирается общим шагом оркестратора по `userId`; встреча — запись
 * организации, уходит с её каскадом. Здесь — посев канарейки.
 */
@Injectable()
export class OfficeLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.canary.register('office.subject', (ctx) => this.seedCanary(ctx));
  }

  /** Закрытая встреча соседа (кроны офиса её не трогают) с участием обоих: строка человека исчезает. */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const room = await this.db.officeRoom.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: ctx.marker,
        status: 'ended',
        endedAt: new Date(),
        createdById: ctx.peerId,
        participants: { create: [{ userId: ctx.userId }, { userId: ctx.peerId, role: 'host' }] },
      },
      select: { id: true, participants: { select: { id: true, userId: true } } },
    });
    return [
      { policy: 'OfficeRoom', id: room.id, expect: 'kept', tenant: true },
      ...room.participants.map((p) => ({ policy: 'OfficeRoomParticipant', id: p.id, expect: p.userId === ctx.userId ? ('gone' as const) : ('kept' as const), tenant: true })),
    ];
  }
}
