import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JobsRegistry } from '../../core/jobs/jobs.registry';
import { CALLS_SESSION_SUMMARIZE_JOB } from '../../core/calls/calls.service';
import { MessengerService } from './messenger.service';

/**
 * Звонки в чатах (refType='chat'): мост событий движка core/calls на realtime
 * `call:state` (через messenger.call.state → gateway) и итоговые плашки.
 * Best-effort — сбой здесь не влияет на сам звонок. Шина at-most-once → ринг у DM
 * стартует по participant_joined, а страхует его клиентский поллинг активных звонков
 * (CallsWatcher, 12с) — потерянное событие не «вешает»/«теряет» звонок навсегда.
 * Итоговая плашка идемпотентна по CallSession.summarizedAt (повтор доставки не дублит).
 *
 *  - call.participant.joined|left → call:state (у DM это и есть зажигание/гашение
 *    ринга: клиент рингует только при непустых participants без себя).
 *  - call.session.started → call:state (идемпотентный дубль синхронного фанаута).
 *  - call.session.ended → call:state(null) + ОДНА итоговая плашка (WhatsApp-стиль):
 *    «Звонок · N мин», а для DM, где второй участник так и не подключился, —
 *    «Пропущенный звонок» + уведомление call.missed. Сессии, куда вообще никто
 *    не зашёл («токен взял и умер»), не оставляют следов.
 *  - call.recording.* → call:state (индикатор «● Запись» у всех).
 */
@Injectable()
export class ChatCallsListener implements OnModuleInit {
  private readonly logger = new Logger(ChatCallsListener.name);

  constructor(
    private readonly events: EventBusService,
    private readonly db: DatabaseService,
    private readonly messenger: MessengerService,
    private readonly notifications: NotificationsService,
    private readonly jobsRegistry: JobsRegistry,
  ) {}

  onModuleInit() {
    // Итоговая плашка звонка чата — джоб core/jobs (ставит core/calls в tx закрытия сессии):
    // заменил и бус-плашку, и sweep-крон. endedById приходит в payload (в БД не хранится).
    this.jobsRegistry.register(CALLS_SESSION_SUMMARIZE_JOB, (payload) =>
      this.handleSummarizeJob(String(payload.sessionId), (payload.endedById as string | null) ?? null),
    );
    this.events.onPattern('call.session.*').subscribe((e) => {
      void this.handleSession(e.type, (e.payload ?? {}) as ChatCallPayload);
    });
    this.events.onPattern('call.participant.*').subscribe((e) => {
      void this.handleParticipant((e.payload ?? {}) as ChatCallPayload);
    });
    this.events.onPattern('call.recording.*').subscribe((e) => {
      void this.handleParticipant((e.payload ?? {}) as ChatCallPayload);
    });
  }

  /**
   * Обработчик джоба `calls.session.summarize`: реконструирует payload из журнала сессии
   * (endedById приходит в payload — в БД не хранится) и постит итоговую плашку. Идемпотентно
   * по CallSession.summarizedAt (ретрай/дубль не задвоят). Заменил и бус-плашку, и sweep-крон.
   */
  private async handleSummarizeJob(sessionId: string, endedById: string | null): Promise<void> {
    const s = await this.db.callSession.findUnique({ where: { id: sessionId } });
    if (!s || s.refType !== 'chat') return; // не chat / удалена — no-op
    const parts = await this.db.callSessionParticipant.findMany({
      where: { sessionId: s.id },
      select: { userId: true, joinedAt: true },
    });
    const firstJoinedAt = parts.reduce<Date | null>(
      (min, p) => (min === null || p.joinedAt < min ? p.joinedAt : min),
      null,
    );
    await this.postSummaryPlaque(s.refId, {
      sessionId: s.id,
      refType: 'chat',
      refId: s.refId,
      startedById: s.startedById,
      startedAt: s.startedAt.toISOString(),
      endedAt: (s.endedAt ?? s.updatedAt).toISOString(),
      firstJoinedAt: firstJoinedAt ? firstJoinedAt.toISOString() : null,
      endedById,
      participantUserIds: [...new Set(parts.map((p) => p.userId))],
    });
  }

  private async handleParticipant(p: ChatCallPayload): Promise<void> {
    try {
      if (p.refType !== 'chat' || !p.refId) return; // фильтр по payload — без запросов в БД
      await this.messenger.broadcastCallState(p.refId);
    } catch (err) {
      this.logger.warn(`call:state relay failed (non-fatal): ${String((err as Error)?.message ?? err)}`);
    }
  }

  private async handleSession(type: string, p: ChatCallPayload): Promise<void> {
    try {
      if (p.refType !== 'chat' || !p.refId) return;
      const chatId = p.refId;
      if (type === 'call.session.started') {
        await this.messenger.broadcastCallState(chatId);
        return;
      }
      if (type === 'call.session.ended') {
        // Снимок уже пуст (сессия ended) — рассылаем гашение явно (realtime).
        // Итоговую плашку постит джоб calls.session.summarize (надёжно, в tx закрытия сессии).
        await this.messenger.broadcastCallState(chatId, null);
        return;
      }
    } catch (err) {
      this.logger.warn(`call plaque failed (non-fatal): ${String((err as Error)?.message ?? err)}`);
    }
  }

  /** Одна итоговая строка на звонок (плашек «начался/подключился» нет осознанно — спам). */
  private async postSummaryPlaque(chatId: string, p: ChatCallPayload): Promise<void> {
    const joined = p.participantUserIds ?? [];
    if (!joined.length || !p.sessionId) return; // никто не подключился — звонка по сути не было

    // Идемпотентность: клеймим «плашка постнута» на сессии — повторная доставка шины
    // (XAUTOCLAIM после потерянного xack) не задвоит плашку/уведомление.
    const claimed = await this.db.callSession.updateMany({
      where: { id: p.sessionId, summarizedAt: null },
      data: { summarizedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: { type: true, members: { select: { userId: true } } },
    });
    if (!chat) return;

    if (chat.type === 'dm') {
      const absent = chat.members.map((m) => m.userId).filter((id) => !joined.includes(id));
      if (absent.length) {
        // Второй участник так и не подключился — «пропущенный» (отклонение тоже, как в Telegram)
        await this.messenger.postChatSystemMessage(chatId, 'call.missed', 'Пропущенный звонок');
        const fromName = (await this.nameOf(p.startedById)) ?? 'собеседника';
        for (const userId of absent) {
          // Ни звонящему, ни тому, кто сам завершил (нажал «Отклонить»), — «Пропущенный» не шлём
          if (userId === p.startedById || userId === p.endedById) continue;
          await this.notifications
            .notify(userId, 'call.missed', { fromName }, { actionUrl: `/messenger?chat=${chatId}` })
            .catch(() => undefined);
        }
        return;
      }
    }
    await this.messenger.postChatSystemMessage(
      chatId,
      'call.ended',
      `Звонок · ${this.formatCallDuration(p.firstJoinedAt ?? p.startedAt, p.endedAt)}`,
    );
  }

  /** Длительность разговора: от первого реального входа до завершения (не от старта дозвона). */
  private formatCallDuration(fromIso?: string | null, toIso?: string | null): string {
    const from = fromIso ? Date.parse(fromIso) : NaN;
    const to = toIso ? Date.parse(toIso) : Date.now();
    const sec = Number.isFinite(from) ? Math.max(0, Math.round((to - from) / 1000)) : 0;
    if (sec < 60) return `${sec} сек`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} мин`;
    return `${Math.floor(min / 60)} ч ${min % 60} мин`;
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

interface ChatCallPayload {
  sessionId?: string;
  refType?: string;
  refId?: string;
  startedById?: string;
  startedAt?: string;
  /** Момент завершения (для длительности плашки — не Date.now() после задержки крона) */
  endedAt?: string;
  /** Первый реально вошедший — база длительности (исключает время дозвона) */
  firstJoinedAt?: string | null;
  /** Кто завершил созвон (DM «Отклонить») — ему «Пропущенный» не шлём */
  endedById?: string | null;
  participantUserIds?: string[];
  userId?: string;
  reason?: string;
  [key: string]: unknown;
}
