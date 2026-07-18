import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { SCHEDULED_MESSAGE_LIMITS, type ScheduledMessageItem } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { AccessService } from '../../core/access/access.service';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { MessengerService } from './messenger.service';

/**
 * Scheduled messages ("Напомнить", Phase 7): the author schedules a message; ScheduledCron
 * fires due ones → posts a normal message FROM the author into the chat + pings the author
 * (so their own message — which won't show as unread — still reminds them). The author can
 * view/edit/cancel while pending. Registers the 'message.schedule' quick-action on init.
 */
@Injectable()
export class ScheduledMessageService implements OnModuleInit {
  private readonly logger = new Logger(ScheduledMessageService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly messenger: MessengerService,
    private readonly quickActions: QuickActionRegistry,
  ) {}

  /** Чистка закрытых строк (sent/cancelled) старше 30 дней — история отправки живёт
   *  в самих сообщениях чата, строка планировщика после выстрела нужна недолго. */
  async purgeOld(): Promise<number> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const res = await this.db.scheduledMessage.deleteMany({
      where: { status: { in: ['sent', 'cancelled'] }, updatedAt: { lt: cutoff } },
    });
    return res.count;
  }

  onModuleInit(): void {
    this.quickActions.register({
      key: 'message.schedule',
      label: 'Напомнить',
      icon: '⏰',
      scopes: ['composer', 'message'],
      description: 'Отложенное сообщение в этот чат',
    });
  }

  private async assertChatAccess(userId: string, chatId: string): Promise<void> {
    const ok = await this.access.can({ type: 'user', id: userId }, 'chat.view', chatId);
    if (!ok) throw new ForbiddenException('Нет доступа к чату');
  }

  private validateSendAt(iso: string): Date {
    const sendAt = new Date(iso);
    const now = Date.now();
    if (Number.isNaN(sendAt.getTime())) throw new BadRequestException('Некорректное время');
    if (sendAt.getTime() < now + SCHEDULED_MESSAGE_LIMITS.minLeadSeconds * 1000) {
      throw new BadRequestException('Время уже прошло или слишком близко');
    }
    if (sendAt.getTime() > now + SCHEDULED_MESSAGE_LIMITS.maxHorizonDays * 86_400_000) {
      throw new BadRequestException('Слишком далеко в будущем');
    }
    return sendAt;
  }

  async schedule(
    userId: string,
    chatId: string,
    content: string,
    sendAtIso: string,
    replyToId?: string,
  ): Promise<ScheduledMessageItem> {
    await this.assertChatAccess(userId, chatId);
    const sendAt = this.validateSendAt(sendAtIso);

    if (replyToId) {
      const parent = await this.db.message.findUnique({
        where: { id: replyToId },
        select: { chatId: true },
      });
      if (!parent || parent.chatId !== chatId) {
        throw new BadRequestException('Можно цитировать только сообщение из этого чата');
      }
    }

    const pending = await this.db.scheduledMessage.count({
      where: { chatId, authorId: userId, status: 'pending' },
    });
    if (pending >= SCHEDULED_MESSAGE_LIMITS.maxPendingPerChat) {
      throw new BadRequestException('Слишком много запланированных сообщений в этом чате');
    }

    const row = await this.db.scheduledMessage.create({
      data: { chatId, authorId: userId, content, replyToId: replyToId ?? null, sendAt, status: 'pending' },
    });
    return this.toItem(row);
  }

  /** The viewer's own PENDING scheduled messages in a chat. */
  async listForChat(userId: string, chatId: string): Promise<ScheduledMessageItem[]> {
    await this.assertChatAccess(userId, chatId);
    const rows = await this.db.scheduledMessage.findMany({
      where: { chatId, authorId: userId, status: 'pending' },
      orderBy: { sendAt: 'asc' },
    });
    return rows.map((r) => this.toItem(r));
  }

  async update(
    userId: string,
    id: string,
    patch: { content?: string; sendAt?: string },
  ): Promise<ScheduledMessageItem> {
    const row = await this.db.scheduledMessage.findUnique({ where: { id } });
    if (!row || row.authorId !== userId) throw new NotFoundException('Запланированное сообщение не найдено');
    if (row.status !== 'pending') throw new BadRequestException('Уже отправлено или отменено');

    const data: { content?: string; sendAt?: Date } = {};
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.sendAt !== undefined) data.sendAt = this.validateSendAt(patch.sendAt);

    const updated = await this.db.scheduledMessage.update({ where: { id }, data });
    return this.toItem(updated);
  }

  async cancel(userId: string, id: string): Promise<void> {
    const row = await this.db.scheduledMessage.findUnique({ where: { id } });
    if (!row || row.authorId !== userId) throw new NotFoundException('Запланированное сообщение не найдено');
    if (row.status !== 'pending') return;
    await this.db.scheduledMessage.update({ where: { id }, data: { status: 'cancelled' } });
  }

  /**
   * Fire all due pending messages (called by the cron under a Redis lock). Posts each as a
   * normal message from the author + pings the author. A permanent failure (author lost chat
   * access / chat gone) cancels the row; a transient error leaves it pending to retry.
   */
  async fireDue(): Promise<number> {
    // Recover rows stuck in 'sending' (an instance died mid-send): >10 min past due → re-deliver.
    // At-least-once for reminders is the right trade-off (losing one silently is worse than a dupe).
    await this.db.scheduledMessage.updateMany({
      where: { status: 'sending', sendAt: { lte: new Date(Date.now() - 10 * 60_000) } },
      data: { status: 'pending' },
    });

    const due = await this.db.scheduledMessage.findMany({
      where: { status: 'pending', sendAt: { lte: new Date() } },
      orderBy: { sendAt: 'asc' },
      take: 100,
    });

    let fired = 0;
    for (const sm of due) {
      // Claim the row (pending → sending) BEFORE sending: overlapping cron runs (a stolen/expired
      // Redis lock) then can't double-send — exactly one instance wins the updateMany.
      const claimed = await this.db.scheduledMessage.updateMany({
        where: { id: sm.id, status: 'pending' },
        data: { status: 'sending' },
      });
      if (claimed.count === 0) continue;
      try {
        const msg = await this.messenger.sendMessage(
          sm.authorId,
          sm.chatId,
          sm.content,
          sm.replyToId ?? undefined,
        );
        await this.db.scheduledMessage.update({
          where: { id: sm.id },
          data: { status: 'sent', sentMessageId: msg.id },
        });
        fired++;
        try {
          await this.notifications.notify(
            sm.authorId,
            'messenger.scheduled.sent',
            { snippet: sm.content.slice(0, 140) },
            { actionUrl: `/messenger?chat=${sm.chatId}&msg=${msg.id}` },
          );
        } catch (e) {
          this.logger.warn(`scheduled notify failed for ${sm.id}: ${String(e)}`);
        }
      } catch (e) {
        if (e instanceof ForbiddenException || e instanceof NotFoundException) {
          // Permanent (left chat / chat deleted) → cancel so it doesn't retry forever.
          await this.db.scheduledMessage
            .update({ where: { id: sm.id }, data: { status: 'cancelled' } })
            .catch(() => {});
          this.logger.warn(`scheduled ${sm.id} cancelled (no access): ${String(e)}`);
        } else {
          // Transient → release the claim so the next run retries.
          await this.db.scheduledMessage
            .updateMany({ where: { id: sm.id, status: 'sending' }, data: { status: 'pending' } })
            .catch(() => {});
          this.logger.warn(`scheduled ${sm.id} send failed (will retry): ${String(e)}`);
        }
      }
    }
    return fired;
  }

  private toItem(r: {
    id: string;
    chatId: string;
    content: string;
    replyToId: string | null;
    sendAt: Date;
    status: string;
    createdAt: Date;
  }): ScheduledMessageItem {
    return {
      id: r.id,
      chatId: r.chatId,
      content: r.content,
      replyToId: r.replyToId ?? null,
      sendAt: r.sendAt.toISOString(),
      status: r.status as ScheduledMessageItem['status'],
      createdAt: r.createdAt.toISOString(),
    };
  }
}
