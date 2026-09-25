import { Injectable } from '@nestjs/common';
import {
  LIFECYCLE_CHAT_TIMER_PRESETS,
  LIFECYCLE_FOREVER,
  lifecyclePolicy,
  resolveLifecycleRetention,
  type ChatRetentionDto,
  type LifecycleTenantClass,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { LifecycleSettings } from '../../core/lifecycle/lifecycle.settings';

const DAY_MS = 86_400_000;
/** Пол ленты живёт в памяти 5 минут (правило принуждения при чтении: сдвиг границы — не мгновенный, но дешёвый). */
const FLOOR_TTL_MS = 5 * 60_000;
const FLOOR_CACHE_MAX = 20_000;

/** Что о чате нужно сроку: организация и таймер. */
export interface ChatRetentionRef {
  id: string;
  type: string;
  workspaceId: string | null;
  messageTtlDays: number | null;
}

/** Виды чата с таймером: личная переписка и группа (у контекстного чата жизнь задаёт предмет). */
export const CHAT_TIMER_TYPES: readonly string[] = ['dm', 'group'];

/**
 * Сроки сообщений чата (core/lifecycle Э5): таймер автоудаления (человек) и срок сообщений
 * организации — действующий срок min(таймер, срок организации), с полом закона политики
 * `Message`. Сообщения старше срока НЕ показываются сразу (правило принуждения при чтении),
 * раннер `messenger.retention` лишь освобождает место.
 *
 * Граница ленты — «пол» `seq`: первое сообщение не старше срока. Лента, непрочитанные и поиск
 * режут по нему индексом `(chatId, seq)`: удерживаемые заморозкой старые сообщения остаются в
 * базе, но каждую страницу мимо них не сканируют. Пол живёт в памяти процесса 5 минут, у
 * процесса, сменившего таймер, — сбрасывается сразу.
 */
@Injectable()
export class MessengerRetentionService {
  private readonly floors = new Map<string, { at: number; floor: number }>();
  private readonly policy = lifecyclePolicy('Message')!;

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: LifecycleSettings,
  ) {}

  /** Срок сообщений, выбранный организацией (null — не выбирала или «вечно»). */
  async workspaceDays(workspaceId: string | null): Promise<number | null> {
    if (!workspaceId) return null;
    const choice = await this.settings.tenantChoice(workspaceId, this.policy.dataClass as LifecycleTenantClass);
    const { days } = resolveLifecycleRetention({ policy: this.policy, tenantDays: choice ?? undefined });
    return days === LIFECYCLE_FOREVER || days === 0 ? null : days;
  }

  /** Действующий срок сообщений чата в сутках; null — хранится вечно. */
  async effectiveDays(chat: ChatRetentionRef): Promise<number | null> {
    const choice = chat.workspaceId ? await this.settings.tenantChoice(chat.workspaceId, this.policy.dataClass as LifecycleTenantClass) : null;
    const { days } = resolveLifecycleRetention({
      policy: this.policy,
      tenantDays: choice ?? undefined,
      userDays: chat.messageTtlDays ?? undefined,
    });
    return days === LIFECYCLE_FOREVER || days === 0 ? null : days;
  }

  /** Сообщения старше этого момента — вне срока чата; null — срок вечен. */
  async cutoffOf(chat: ChatRetentionRef, now = new Date()): Promise<Date | null> {
    const days = await this.effectiveDays(chat);
    return days === null ? null : new Date(now.getTime() - days * DAY_MS);
  }

  /**
   * Пол ленты: первый `seq`, не старший срока (0 — пола нет). Все сообщения старше —
   * пол за последним сообщением: лента пуста.
   */
  async floorOf(chat: ChatRetentionRef): Promise<number> {
    const now = Date.now();
    const hit = this.floors.get(chat.id);
    if (hit && now - hit.at < FLOOR_TTL_MS) return hit.floor;
    const cutoff = await this.cutoffOf(chat, new Date(now));
    let floor = 0;
    if (cutoff) {
      const [first] = await this.db.$queryRaw<Array<{ seq: number }>>`
        SELECT m."seq" FROM "messages" m
         WHERE m."chat_id" = ${chat.id}::uuid AND m."created_at" >= ${utcTs(cutoff)}
         ORDER BY m."seq" ASC LIMIT 1`;
      if (first) floor = Number(first.seq);
      else {
        const c = await this.db.chat.findUnique({ where: { id: chat.id }, select: { lastSeq: true } });
        floor = (c?.lastSeq ?? 0) + 1;
      }
    }
    if (this.floors.size >= FLOOR_CACHE_MAX) this.floors.clear();
    this.floors.set(chat.id, { at: now, floor });
    return floor;
  }

  /** Сообщение вне срока чата (лента его уже не показывает). */
  async isExpired(chat: ChatRetentionRef, message: { seq: number }): Promise<boolean> {
    const floor = await this.floorOf(chat);
    return floor > 0 && message.seq < floor;
  }

  /** Сбросить пол чата (таймер сменился) — у этого процесса сразу, у соседних ≤ 5 минут. */
  invalidate(chatId: string): void {
    this.floors.delete(chatId);
  }

  /** Сроки чата глазами участника: таймер, срок организации, действующий срок, доступные пресеты. */
  async describe(chat: ChatRetentionRef, canChange: boolean): Promise<ChatRetentionDto> {
    const workspaceDays = await this.workspaceDays(chat.workspaceId);
    const allowedPresets = CHAT_TIMER_TYPES.includes(chat.type) ? LIFECYCLE_CHAT_TIMER_PRESETS.filter((d) => workspaceDays === null || d <= workspaceDays) : [];
    return {
      timerDays: chat.messageTtlDays,
      workspaceDays,
      effectiveDays: await this.effectiveDays(chat),
      allowedPresets,
      canChange: canChange && CHAT_TIMER_TYPES.includes(chat.type),
    };
  }
}
