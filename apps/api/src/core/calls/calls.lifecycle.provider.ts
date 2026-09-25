import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../lifecycle/lifecycle.purge.registry';

/**
 * Звонки в движке сроков core/lifecycle: участие человека в звонке и его заявка на запись
 * (`CallSessionParticipant`, `CallRecordingClaim`) стираются общими шагами оркестратора по
 * `userId`; звонок и запись того, кто их начал, остаются ему. Здесь — посев канарейки.
 */
@Injectable()
export class CallsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.canary.register('calls.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Звонок соседа (закончен — реконсиляция LiveKit его не трогает) с участием обоих и готовая
   * запись (доставлена — хук доставки молчит) с заявками обоих: строки человека исчезают,
   * соседа — остаются.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const now = new Date();
    const session = await this.db.callSession.create({
      data: {
        roomName: `canary_${randomUUID()}`,
        refType: 'chat',
        refId: randomUUID(),
        startedById: ctx.peerId,
        status: 'ended',
        endedAt: now,
        participants: { create: [{ userId: ctx.userId, leftAt: now }, { userId: ctx.peerId, leftAt: now }] },
        recordings: {
          create: {
            refType: 'chat',
            refId: randomUUID(),
            startedById: ctx.peerId,
            status: 'ready',
            endedAt: now,
            claims: { create: [{ userId: ctx.userId, deliveredAt: now }, { userId: ctx.peerId, deliveredAt: now }] },
          },
        },
      },
      select: {
        id: true,
        participants: { select: { id: true, userId: true } },
        recordings: { select: { id: true, claims: { select: { id: true, userId: true } } } },
      },
    });
    const whose = (userId: string) => (userId === ctx.userId ? ('gone' as const) : ('kept' as const));
    return [
      { policy: 'CallSession', id: session.id, expect: 'kept' },
      ...session.participants.map((p) => ({ policy: 'CallSessionParticipant', id: p.id, expect: whose(p.userId) })),
      ...session.recordings.flatMap((r) => [
        { policy: 'CallRecording', id: r.id, expect: 'kept' as const },
        ...r.claims.map((c) => ({ policy: 'CallRecordingClaim', id: c.id, expect: whose(c.userId) })),
      ]),
    ];
  }
}
