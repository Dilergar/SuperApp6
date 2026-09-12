import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { EntitlementSubjectRef, NotificationType } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { AudiencesService } from '../audiences/audiences.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { ENTITLEMENT_NOTIFICATION_REF_TYPE } from './entitlements.constants';

type Tx = Prisma.TransactionClient;

/**
 * Уведомления движка: продюсер решает КОМУ — человек получает про себя, организация —
 * владелец и админы (через core/audiences, вид `workspace` с фильтром ролей);
 * движок уведомлений решает КАК. Deep link — раздел «Тариф и лимиты» контекста.
 */
@Injectable()
export class EntitlementsNotifier implements OnModuleInit {
  private readonly logger = new Logger(EntitlementsNotifier.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly refs: NotificationRefRegistry,
    private readonly audiences: AudiencesService,
  ) {}

  onModuleInit(): void {
    this.refs.register(ENTITLEMENT_NOTIFICATION_REF_TYPE, {
      canViewMany: async (userIds, refId) => {
        const subject = this.subjectOfRef(refId);
        if (!subject) return [];
        const allowed = new Set(await this.recipientsOf(subject));
        return userIds.filter((id) => allowed.has(id));
      },
      href: (_ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/profile/subscription` : '/profile/subscription'),
    });
  }

  refIdOf(subject: EntitlementSubjectRef): string {
    return `${subject.type}:${subject.id}`;
  }

  subjectOfRef(refId: string): EntitlementSubjectRef | null {
    const sep = refId.indexOf(':');
    if (sep <= 0) return null;
    const type = refId.slice(0, sep);
    if (type !== 'user' && type !== 'workspace' && type !== 'family') return null;
    return { type, id: refId.slice(sep + 1) };
  }

  /** user → сам человек; workspace → владелец + админы; family — зарезервировано (никому). */
  async recipientsOf(subject: EntitlementSubjectRef): Promise<string[]> {
    if (subject.type === 'user') {
      const u = await this.db.user.findUnique({ where: { id: subject.id }, select: { id: true, deletedAt: true } });
      return u && !u.deletedAt ? [u.id] : [];
    }
    if (subject.type === 'workspace') {
      try {
        return await this.audiences.resolve([{ type: 'workspace', id: subject.id }], { workspaceId: subject.id }, {
          max: 50,
          onOverflow: 'truncate',
          roles: ['owner', 'admin'],
        });
      } catch (err) {
        this.logger.warn(`recipients of workspace ${subject.id} failed: ${(err as Error).message}`);
        return [];
      }
    }
    return [];
  }

  /**
   * Отправить уведомление субъекту. `tx=null` — вне транзакции (крон/пост-коммит).
   * Одно на порог за период — `idempotencyKey` продюсера + `collapse: 'type'` типа.
   */
  async notify(
    tx: Tx | null,
    subject: EntitlementSubjectRef,
    type: NotificationType,
    payload: Record<string, unknown>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<void> {
    const recipients = await this.recipientsOf(subject);
    if (!recipients.length) return;
    try {
      await this.notifications.send(tx, {
        type,
        to: recipients.map((userId) => ({ userId })),
        payload,
        ref: { type: ENTITLEMENT_NOTIFICATION_REF_TYPE, id: this.refIdOf(subject) },
        workspaceId: subject.type === 'workspace' ? subject.id : null,
        reason: subject.type === 'workspace' ? 'owner' : 'system',
        idempotencyKey: opts.idempotencyKey,
      });
    } catch (err) {
      // Уведомление — не security-эффект: сбой ленты не должен ронять списание квоты
      this.logger.warn(`notify ${type} for ${this.refIdOf(subject)} failed: ${(err as Error).message}`);
      if (tx) throw err; // внутри чужой транзакции ошибку глотать нельзя — она уже её пометила
    }
  }
}
