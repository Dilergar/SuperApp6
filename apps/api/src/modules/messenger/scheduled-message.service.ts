import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { SCHEDULED_MESSAGE_LIMITS, type ScheduledMessageItem } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { AccessService } from '../../core/access/access.service';
import { JobDiscardError, JobsRegistry } from '../../core/jobs/jobs.registry';
import { JobsService } from '../../core/jobs/jobs.service';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { MessengerService } from './messenger.service';

/** Тип джоба выстрела (core/jobs); один живой джоб на ВЕРСИЮ времени: uniqueKey `sm:<id>:<sendAtMs>`. */
const SCHEDULED_FIRE_JOB = 'messenger.scheduled.fire';

/**
 * Scheduled messages ("Напомнить", Phase 7): the author schedules a message; a core/jobs
 * job with runAt=sendAt fires it → posts a normal message FROM the author into the chat +
 * pings the author. Постановка/перенос/отмена джоба — в одной транзакции с доменной
 * строкой (outbox); ключ джоба несёт версию времени, поэтому перенос = отмена старого
 * ключа + новый джоб, а гонка «правка в момент выстрела» решается сверкой sendAt в
 * обработчике. Личный крон-поллер (fireDue) движку больше не нужен.
 * Registers the 'message.schedule' quick-action on init.
 */
@Injectable()
export class ScheduledMessageService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledMessageService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly messenger: MessengerService,
    private readonly quickActions: QuickActionRegistry,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
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
    // Ретраев больше, чем дефолт движка: напоминание ценнее, чем экономия попыток
    // (старый крон ретраил бесконечно; 8 попыток с бэкоффом ≈ до ~2 часов).
    this.jobsRegistry.register(
      SCHEDULED_FIRE_JOB,
      (payload) => this.handleFireJob(payload),
      { maxAttempts: 8 },
    );
  }

  /**
   * Бэкфилл деплой-перехода: pending-строки без джоба (доджобовая эра) получают джоб;
   * uniqueKey с версией времени дедупит против уже живых.
   */
  onApplicationBootstrap(): void {
    void this.backfillJobs().catch((err) =>
      this.logger.warn(`scheduled backfill failed: ${String((err as Error)?.message ?? err)}`),
    );
  }

  private jobKey(id: string, sendAt: Date): string {
    return `sm:${id}:${sendAt.getTime()}`;
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

    // Строка + джоб выстрела в одной транзакции (outbox: откат не оставляет ни того, ни другого).
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.scheduledMessage.create({
        data: { chatId, authorId: userId, content, replyToId: replyToId ?? null, sendAt, status: 'pending' },
      });
      await this.jobs.enqueue(tx, {
        type: SCHEDULED_FIRE_JOB,
        payload: { scheduledMessageId: created.id, sendAtMs: sendAt.getTime() },
        uniqueKey: this.jobKey(created.id, sendAt),
        runAt: sendAt,
      });
      return created;
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

    // Перенос времени = новый ключ джоба (версия времени): старый отменяем, новый ставим —
    // в одной транзакции с правкой строки. Если старый джоб прямо сейчас executing
    // (правка в момент выстрела), его отмена промахнётся — обработчик сам увидит
    // несовпадение sendAt и завершится no-op'ом. Правка только текста джоб не трогает
    // (обработчик читает строку заново).
    const updated = await this.db.$transaction(async (tx) => {
      const upd = await tx.scheduledMessage.update({ where: { id }, data });
      if (data.sendAt) {
        await this.jobs.cancelByUniqueKey(tx, SCHEDULED_FIRE_JOB, this.jobKey(id, row.sendAt));
        await this.jobs.enqueue(tx, {
          type: SCHEDULED_FIRE_JOB,
          payload: { scheduledMessageId: id, sendAtMs: data.sendAt.getTime() },
          uniqueKey: this.jobKey(id, data.sendAt),
          runAt: data.sendAt,
        });
      }
      return upd;
    });
    return this.toItem(updated);
  }

  async cancel(userId: string, id: string): Promise<void> {
    const row = await this.db.scheduledMessage.findUnique({ where: { id } });
    if (!row || row.authorId !== userId) throw new NotFoundException('Запланированное сообщение не найдено');
    if (row.status !== 'pending') return;
    await this.db.$transaction(async (tx) => {
      await tx.scheduledMessage.update({ where: { id }, data: { status: 'cancelled' } });
      // Промах по executing не страшен: обработчик увидит status=cancelled → no-op.
      await this.jobs.cancelByUniqueKey(tx, SCHEDULED_FIRE_JOB, this.jobKey(id, row.sendAt));
    });
  }

  /**
   * Обработчик джоба выстрела. Ретраи/бэкофф/dead-letter — у движка; здесь — доменная
   * идемпотентность: сверка версии времени (перенос = чужой ключ → no-op), claim
   * pending→sending. Строка в 'sending' = наш же упавший заход (джоб на версию один) —
   * продолжаем отправку: at-least-once, дубль напоминания лучше тихой потери (прежняя
   * семантика fireDue). Постоянная ошибка (вышел из чата / чат удалён) → строка
   * cancelled + JobDiscardError.
   */
  private async handleFireJob(payload: Record<string, unknown>): Promise<void> {
    const id = String(payload.scheduledMessageId ?? '');
    const sendAtMs = Number(payload.sendAtMs ?? 0);
    const row = await this.db.scheduledMessage.findUnique({ where: { id } });
    if (!row || row.status === 'sent' || row.status === 'cancelled') return;
    if (row.sendAt.getTime() !== sendAtMs) return; // время переназначили — живёт джоб новой версии

    const claimed = await this.db.scheduledMessage.updateMany({
      where: { id, status: { in: ['pending', 'sending'] } },
      data: { status: 'sending' },
    });
    if (claimed.count === 0) return;

    try {
      const msg = await this.messenger.sendMessage(
        row.authorId,
        row.chatId,
        row.content,
        row.replyToId ?? undefined,
      );
      await this.db.scheduledMessage.update({
        where: { id },
        data: { status: 'sent', sentMessageId: msg.id },
      });
      try {
        await this.notifications.notify(
          row.authorId,
          'messenger.scheduled.sent',
          { snippet: row.content.slice(0, 140) },
          { actionUrl: `/messenger?chat=${row.chatId}&msg=${msg.id}` },
        );
      } catch (e) {
        this.logger.warn(`scheduled notify failed for ${id}: ${String(e)}`);
      }
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof NotFoundException) {
        await this.db.scheduledMessage
          .update({ where: { id }, data: { status: 'cancelled' } })
          .catch(() => {});
        throw new JobDiscardError(`нет доступа/чат удалён: ${(e as Error).message}`);
      }
      // Transient → вернуть строку в pending и отдать ошибку движку (бэкофф-ретрай).
      await this.db.scheduledMessage
        .updateMany({ where: { id, status: 'sending' }, data: { status: 'pending' } })
        .catch(() => {});
      throw e;
    }
  }

  /** Бэкфилл: pending-строки без живого джоба (см. onApplicationBootstrap). */
  private async backfillJobs(): Promise<void> {
    const rows = await this.db.scheduledMessage.findMany({
      where: { status: { in: ['pending', 'sending'] } },
      select: { id: true, sendAt: true },
    });
    for (const r of rows) {
      await this.jobs.enqueue(null, {
        type: SCHEDULED_FIRE_JOB,
        payload: { scheduledMessageId: r.id, sendAtMs: r.sendAt.getTime() },
        uniqueKey: this.jobKey(r.id, r.sendAt),
        runAt: r.sendAt,
      });
    }
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
