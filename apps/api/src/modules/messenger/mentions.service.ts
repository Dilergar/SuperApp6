import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationsService } from '../../core/notifications/notifications.service';
import { AccessService } from '../../core/access/access.service';
import { fullName } from '../../shared/utils/user-name';
import { parseMentions, MENTION_LIMITS, type MentionCandidate, type MentionSourceType } from '@superapp/shared';

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

/**
 * Детектор упоминаний. Отдельной модели Mention больше нет: упоминание = уведомление
 * `mention.received` с `ref` на сообщение/источник и `reason: 'mention'` (вкладка
 * «Упоминания» центра = фильтр ленты; mute объекта его не глушит).
 *
 * Идемпотентность — у источника: `idempotencyKey = mention:<messageId>:<userId>`
 * (правка сообщения не шлёт повторно; новый @ в правке — новое событие).
 * Best-effort: сбой здесь никогда не ломает sendMessage/editMessage.
 */
@Injectable()
export class MentionsService {
  private readonly logger = new Logger(MentionsService.name);

  constructor(
    private db: DatabaseService,
    private notifications: NotificationsService,
    private access: AccessService,
  ) {}

  /** Ключ идемпотентности упоминания в источнике */
  static keyOf(sourceType: MentionSourceType, sourceId: string, userId: string, messageId?: string | null): string {
    return messageId ? `mention:${messageId}:${userId}` : `mention:${sourceType}:${sourceId}:${userId}`;
  }

  /**
   * @-упоминания свежесохранённого сообщения: security-фильтр «только активные участники
   * чата» (текст токена — под контролем автора, таблица членства — нет), затем событие
   * каждому; повтор при правке гасит ключ идемпотентности.
   */
  async recordMessageMentions(opts: {
    content: string | null | undefined;
    chatId: string;
    messageId: string;
    authorId: string;
    chatType: string;
  }): Promise<void> {
    const { content, chatId, messageId, authorId } = opts;
    try {
      if (!content) return;
      const parsed = parseMentions(content);
      if (parsed.length === 0) return;
      const candidateIds = [...new Set(parsed.map((p) => p.userId).filter((id) => id && id !== authorId))];
      if (candidateIds.length === 0) return;

      const members = await this.db.chatMember.findMany({
        where: { chatId, userId: { in: candidateIds }, leftAt: null },
        select: { userId: true },
      });
      const keptIds = members.map((m) => m.userId);
      if (keptIds.length === 0) return;

      const [author, chat] = await Promise.all([
        this.db.user.findUnique({ where: { id: authorId }, select: USER_LITE }),
        this.db.chat.findUnique({ where: { id: chatId }, select: { workspaceId: true } }),
      ]);
      const mentionerName = fullName(author);
      const snippet = content.slice(0, MENTION_LIMITS.snippetLength);
      for (const userId of keptIds) {
        await this.notifications
          .send(null, {
            type: 'mention.received',
            to: [{ userId }],
            payload: { mentionerName, snippet, chatId, messageId, sourceType: 'messenger', sourceId: chatId },
            ref: { type: 'chat_message', id: messageId },
            actorId: authorId,
            workspaceId: chat?.workspaceId ?? null,
            reason: 'mention',
            actionUrl: `/messenger?chat=${chatId}&msg=${messageId}`,
            idempotencyKey: MentionsService.keyOf('messenger', chatId, userId, messageId),
          })
          .catch((e) => this.logger.warn(`mention send failed for ${userId}: ${String(e)}`));
      }
    } catch (e) {
      this.logger.warn(`recordMessageMentions failed (message ${messageId}): ${String(e)}`);
    }
  }

  /**
   * Кто из этих людей УЖЕ упомянут в этом источнике (по ключам идемпотентности событий).
   * Нужен вызывающему, чтобы пропустить дорогую проверку доступа при автосохранении.
   */
  async recordedMentionees(sourceType: MentionSourceType, sourceId: string, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const keys = userIds.map((uid) => MentionsService.keyOf(sourceType, sourceId, uid));
    const rows = await this.db.notificationEvent.findMany({
      where: { type: 'mention.received', idempotencyKey: { in: keys } },
      select: { idempotencyKey: true },
    });
    const found = new Set(rows.map((r) => r.idempotencyKey));
    return new Set(userIds.filter((uid) => found.has(MentionsService.keyOf(sourceType, sourceId, uid))));
  }

  /**
   * Упоминания вне чата (заметки сегодня; задачи/календарь позже): вызывающий САМ
   * отфильтровал адресатов по праву видеть источник.
   */
  async recordMentions(opts: {
    sourceType: MentionSourceType;
    sourceId: string;
    mentionerUserId: string;
    mentionedUserIds: string[];
    snippet: string | null;
    actionUrl: string;
    workspaceId?: string | null;
  }): Promise<void> {
    const { sourceType, sourceId, mentionerUserId, actionUrl } = opts;
    try {
      const candidateIds = [...new Set(opts.mentionedUserIds.filter((id) => id && id !== mentionerUserId))].slice(0, MENTION_LIMITS.maxPerMessage);
      if (!candidateIds.length) return;
      const author = await this.db.user.findUnique({ where: { id: mentionerUserId }, select: USER_LITE });
      const mentionerName = fullName(author);
      const snippet = opts.snippet ? opts.snippet.slice(0, MENTION_LIMITS.snippetLength) : '';
      for (const userId of candidateIds) {
        await this.notifications
          .send(null, {
            type: 'mention.received',
            to: [{ userId }],
            payload: { mentionerName, snippet, sourceType, sourceId },
            ref: { type: sourceType, id: sourceId },
            actorId: mentionerUserId,
            workspaceId: opts.workspaceId ?? null,
            reason: 'mention',
            actionUrl,
            idempotencyKey: MentionsService.keyOf(sourceType, sourceId, userId),
          })
          .catch((e) => this.logger.warn(`mention send failed for ${userId}: ${String(e)}`));
      }
    } catch (e) {
      this.logger.warn(`recordMentions failed (${sourceType} ${sourceId}): ${String(e)}`);
    }
  }

  /** Кандидаты @-пикера: активные участники чата, кроме зрителя (зритель обязан видеть чат). */
  async mentionableMembers(viewerId: string, chatId: string, q?: string): Promise<MentionCandidate[]> {
    const ok = await this.access.can({ type: 'user', id: viewerId }, 'chat.view', chatId);
    if (!ok) return [];
    const members = await this.db.chatMember.findMany({
      where: { chatId, leftAt: null, userId: { not: viewerId } },
      include: { user: { select: USER_LITE } },
    });
    const needle = (q ?? '').trim().toLowerCase();
    return members
      .map((m) => ({ userId: m.userId, name: fullName(m.user), avatar: m.user.avatar }))
      .filter((c) => (needle ? c.name.toLowerCase().includes(needle) : true))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  }
}
