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
    const floor = cutoff ? await this.firstSeqNotOlder(chat.id, cutoff) : 0;
    if (this.floors.size >= FLOOR_CACHE_MAX) this.floors.clear();
    this.floors.set(chat.id, { at: now, floor });
    return floor;
  }

  /**
   * Первый `seq`, чьё сообщение не старше момента, — двоичным поиском по уникальному индексу
   * `(chat_id, seq)`: `seq` и `created_at` растут вместе, поэтому ~log₂(N) точечных чтений вместо
   * `WHERE created_at >= …` с головы чата (у чата под заморозкой истёкшие сообщения живут, и скан
   * платил бы за них каждые 5 минут на процесс). Нет сообщений или все старше — пол за последним
   * (`lastSeq + 1`): лента пуста. Дырки в `seq` (удалённые раннером строки) поиск переступает —
   * зонд берёт первую живую строку с `seq ≥ mid`.
   */
  private async firstSeqNotOlder(chatId: string, cutoff: Date): Promise<number> {
    const cut = utcTs(cutoff);
    const probe = async (seq: number) => {
      const [row] = await this.db.$queryRaw<Array<{ seq: number; fresh: boolean }>>`
        SELECT m."seq"::int AS seq, (m."created_at" >= ${cut}) AS fresh FROM "messages" m
         WHERE m."chat_id" = ${chatId}::uuid AND m."seq" >= ${seq}
         ORDER BY m."seq" ASC LIMIT 1`;
      return row ?? null;
    };
    const [range] = await this.db.$queryRaw<Array<{ lo: number | null; hi: number | null }>>`
      SELECT min(m."seq")::int AS lo, max(m."seq")::int AS hi FROM "messages" m WHERE m."chat_id" = ${chatId}::uuid`;
    const newest = range?.hi === null || range?.hi === undefined ? null : await probe(range.hi);
    if (!newest?.fresh) {
      const c = await this.db.chat.findUnique({ where: { id: chatId }, select: { lastSeq: true } });
      return (c?.lastSeq ?? 0) + 1;
    }
    // Инварианты: живые строки с seq < lo старше срока; ответ ∈ [lo, best]; best — известный «в сроке»
    let lo = range!.lo!;
    let hi = range!.hi!;
    let best = newest.seq;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = await probe(mid);
      if (!row) break;
      if (row.fresh) {
        best = Math.min(best, row.seq);
        hi = mid; // между mid и row.seq живых строк нет — искать левее
      } else {
        lo = row.seq + 1; // всё до row.seq старше (время растёт с seq)
      }
    }
    return best;
  }

  /** Сообщение вне срока чата (лента его уже не показывает). */
  async isExpired(chat: ChatRetentionRef, message: { seq: number }): Promise<boolean> {
    const floor = await this.floorOf(chat);
    return floor > 0 && message.seq < floor;
  }

  /**
   * Можно ли положить текст сообщения в снимок уведомления (упоминание, «отложенное
   * отправлено»): снимок живёт сроком уведомлений, и сообщение с более коротким сроком (таймер,
   * срок организации) пережило бы себя в ленте уведомлений — правило принуждения при чтении
   * обходилось бы через центр уведомлений. Нельзя — уведомление уходит без текста.
   */
  async snippetAllowed(chat: ChatRetentionRef): Promise<boolean> {
    const days = await this.effectiveDays(chat);
    if (days === null) return true;
    const keep = lifecyclePolicy('NotificationEvent')?.retention.defaultDays;
    return keep !== undefined && keep !== LIFECYCLE_FOREVER && days >= keep;
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
