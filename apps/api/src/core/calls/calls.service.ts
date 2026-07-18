import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CallSession, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { WebhookEvent } from 'livekit-server-sdk';
import {
  CALL_LIMITS,
  CallActiveDto,
  CallMuteInput,
  CallsStatusDto,
  CallTokenDto,
  CallTokenInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { CallsLivekitClient } from './calls-livekit.client';
import { CallsRefRegistry, CallsRefResolver } from './calls-ref.registry';
import { CallsRecordingService } from './calls-recording.service';

/**
 * Движок звонков (core/calls, 8-й платформенный): аудио/видеокомнаты LiveKit,
 * привязанные к сущности-родителю полиморфно (refType+refId). Доступ решает
 * резолвер потребителя (CallsRefRegistry) на каждую выдачу токена. Сессия
 * (CallSession) = один созвон: get-or-create при первом токене (partial unique
 * «одна active на ref» гасит гонку), закрывается вебхуком room_finished /
 * модератором / реконсиляцией — сущность-родитель (встреча) живёт дольше.
 * Вебхуки at-least-once → обработка идемпотентна. Инертен без LIVEKIT_*.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly livekit: CallsLivekitClient,
    private readonly registry: CallsRefRegistry,
    private readonly recording: CallsRecordingService,
  ) {}

  getStatus(): CallsStatusDto {
    return {
      enabled: this.livekit.enabled,
      wsUrl: this.livekit.wsUrl,
      recordingEnabled: this.livekit.recordingEnabled,
    };
  }

  /**
   * Живые созвоны для набора сущностей одного refType — батч для DTO потребителей
   * (activeCall в списке чатов; двиг сам читает свои таблицы, потребитель в
   * call_sessions не лезет). Возвращает Map refId → снимок.
   */
  async getActiveForRefs(refType: string, refIds: string[]): Promise<Map<string, CallActiveDto>> {
    const result = new Map<string, CallActiveDto>();
    if (!refIds.length) return result;
    const sessions = await this.db.callSession.findMany({
      where: { refType, refId: { in: refIds }, status: 'active' },
      select: { id: true, refId: true, startedById: true, startedAt: true },
    });
    if (!sessions.length) return result;
    const open = await this.db.callSessionParticipant.findMany({
      where: { sessionId: { in: sessions.map((s) => s.id) }, leftAt: null },
      select: { sessionId: true, userId: true },
    });
    const recordingIds = await this.recording.recordingSessionIds(sessions.map((s) => s.id));
    for (const s of sessions) {
      result.set(s.refId, {
        sessionId: s.id,
        startedById: s.startedById,
        // Дедуп: partial unique гарантирует ≤1 открытую строку на юзера, но снимок не врёт и при гонке
        participantUserIds: [...new Set(open.filter((p) => p.sessionId === s.id).map((p) => p.userId))],
        startedAt: s.startedAt.toISOString(),
        recording: recordingIds.has(s.id),
      });
    }
    return result;
  }

  /**
   * refId'ы ЖИВЫХ сессий одного refType — дешёвый скан по partial-индексу
   * call_sessions_one_active_per_ref (WHERE status='active'). Кормит «перевёрнутый
   * джойн» watcher'а: активных сессий на платформе единицы, а чатов у зрителя тысячи —
   * идём от сессий к членству, типичный случай «звонков нет» = один пустой ответ.
   */
  async listActiveRefIds(refType: string, cap = 2000): Promise<string[]> {
    const sessions = await this.db.callSession.findMany({
      where: { refType, status: 'active' },
      select: { refId: true },
      orderBy: { startedAt: 'desc' },
      take: cap + 1,
    });
    if (sessions.length > cap) {
      this.logger.warn(`listActiveRefIds(${refType}): >${cap} активных сессий — выборка усечена`);
    }
    return sessions.slice(0, cap).map((s) => s.refId);
  }

  /**
   * Живые созвоны одного refType, ОГРАНИЧЕННЫЕ набором refIds (чаты зрителя) — холодная
   * загрузка watcher'а входящих. Пустой refIds → весь refType с потолком (для отладки/
   * админки); потребители должны передавать свои refIds, чтобы не тянуть чужие звонки.
   */
  async listActiveByRefType(refType: string, refIds?: string[]): Promise<Map<string, CallActiveDto>> {
    if (refIds) return this.getActiveForRefs(refType, refIds);
    return this.getActiveForRefs(refType, await this.listActiveRefIds(refType));
  }

  /**
   * Вход в звонок сущности: canJoin-резолвер → get-or-create активной сессии →
   * onJoinAuthorized-хук (материализация участника у потребителя, синхронно) →
   * локально подписанный токен LiveKit.
   */
  async issueToken(userId: string, input: CallTokenInput): Promise<CallTokenDto> {
    this.assertEnabled();
    const resolver = this.registry.get(input.refType);
    if (!resolver) throw new BadRequestException(`Неизвестный тип звонка: ${input.refType}`);
    if (!(await resolver.canJoin(userId, input.refId))) {
      throw new ForbiddenException('Нет доступа к этому звонку');
    }

    const session = await this.ensureActiveSession(userId, input.refType, input.refId, resolver);
    const moderator = await resolver.canModerate(userId, input.refId);
    await resolver.onJoinAuthorized?.(userId, input.refId, session.id);

    // Гонка «сессию завершили между ensureActiveSession и выдачей токена» (модератор нажал
    // «Завершить»): не подписывать токен на комнату, которую уже снесли — иначе клиент
    // подключится и LiveKit (auto_create) воскресит комнату-призрак вне БД/реконсиляции.
    const fresh = await this.db.callSession.findUnique({
      where: { id: session.id },
      select: { status: true },
    });
    if (fresh?.status !== 'active') {
      throw new ConflictException('Звонок уже завершён');
    }

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Участник';

    const token = await this.livekit.mintToken({
      identity: userId,
      name,
      roomName: session.roomName,
      moderator,
      ttlSec: CALL_LIMITS.tokenTtlSec,
    });
    return {
      token,
      wsUrl: this.livekit.wsUrl as string,
      roomName: session.roomName,
      sessionId: session.id,
      moderator,
    };
  }

  /** Завершить созвон для всех (модератор): комната удаляется — участники получают disconnect */
  async endSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.db.callSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Сессия звонка не найдена');
    const resolver = this.registry.get(session.refType);
    if (!resolver || !(await resolver.canModerate(userId, session.refId))) {
      throw new ForbiddenException('Завершать звонок может только модератор');
    }
    await this.endSessionInternal(session, 'moderator', userId);
  }

  /**
   * Закрыть активный созвон сущности — для потребителей, уже авторизовавших действие
   * (офис: «Завершить встречу»). Нет активной сессии → тихий no-op.
   */
  async endActiveForRef(refType: string, refId: string): Promise<void> {
    const session = await this.db.callSession.findFirst({
      where: { refType, refId, status: 'active' },
    });
    if (session) await this.endSessionInternal(session, 'parent_ended');
  }

  /** Исключить участника из комнаты (модератор). Журнал закроет вебхук participant_left. */
  async kick(userId: string, sessionId: string, targetUserId: string): Promise<void> {
    const session = await this.requireModeratedSession(userId, sessionId);
    await this.livekit.removeParticipant(session.roomName, targetUserId);
  }

  /** Принудительно замьютить/размьютить трек участника (модератор) */
  async muteTrack(userId: string, sessionId: string, input: CallMuteInput): Promise<void> {
    const session = await this.requireModeratedSession(userId, sessionId);
    await this.livekit.mutePublishedTrack(session.roomName, input.userId, input.trackSid, input.muted);
  }

  /**
   * Вебхуки LiveKit (at-least-once → всё идемпотентно). room_finished закрывает
   * СЕССИЮ (созвон), не сущность-родителя: встреча-ссылка живёт, новый вход = новая
   * сессия. Журнал участий: «открытая строка» = (sessionId, userId, leftAt IS NULL).
   */
  async handleWebhook(evt: WebhookEvent): Promise<void> {
    // egress_* — ДО room-lookup: у egress-событий evt.room может отсутствовать,
    // ключ — evt.egressInfo.egressId (подсистема записи)
    if (evt.event?.startsWith('egress_')) {
      await this.recording.handleEgressEvent(evt);
      return;
    }
    const roomName = evt.room?.name;
    if (!roomName) return;
    const session = await this.db.callSession.findUnique({ where: { roomName } });
    if (!session) {
      this.logger.warn(`вебхук ${evt.event} для незнакомой комнаты ${roomName} — игнор`);
      return;
    }
    switch (evt.event) {
      case 'room_finished':
        await this.endSessionInternal(session, 'room_finished');
        return;
      case 'participant_joined': {
        const identity = evt.participant?.identity;
        if (!identity) return;
        // Кто-то подключился к комнате уже завершённой сессии — комната-призрак
        // (auto_create воскресил её после deleteRoom): выселяем, журнал не трогаем.
        if (session.status !== 'active') {
          await this.livekit.deleteRoom(session.roomName);
          return;
        }
        try {
          await this.db.callSessionParticipant.create({
            data: { sessionId: session.id, userId: identity },
          });
        } catch (err) {
          // Открытая строка уже есть (повторная доставка) — partial unique гасит дубль
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return;
          }
          throw err;
        }
        await this.touchSession(session.id); // живая сессия выпадает из stale-набора реконсиляции
        this.events.emit(
          'call.participant.joined',
          { ...this.eventPayload(session), userId: identity },
          'calls',
        );
        return;
      }
      case 'participant_left': {
        const identity = evt.participant?.identity;
        if (!identity) return;
        const open = await this.db.callSessionParticipant.findFirst({
          where: { sessionId: session.id, userId: identity, leftAt: null },
          orderBy: { joinedAt: 'desc' },
        });
        if (!open) return; // повторная доставка / joined потерян
        await this.db.callSessionParticipant.update({
          where: { id: open.id },
          data: { leftAt: new Date() },
        });
        await this.touchSession(session.id);
        this.events.emit(
          'call.participant.left',
          { ...this.eventPayload(session), userId: identity },
          'calls',
        );
        return;
      }
      default:
        // room_started и прочее — no-op: сессия создаётся при выдаче токена
        return;
    }
  }

  /**
   * Реконсиляция (крон): активные сессии старше grace, чьих комнат нет в LiveKit —
   * потерянный room_finished или «токен выдан, никто не подключился». LiveKit
   * недоступен → пропуск прогона: НЕ закрывать массово вслепую.
   */
  async reconcileStale(): Promise<number> {
    const cutoff = new Date(Date.now() - CALL_LIMITS.reconcileGraceMin * 60_000);
    const stale = await this.db.callSession.findMany({
      where: { status: 'active', updatedAt: { lt: cutoff } },
      take: 50,
    });
    if (!stale.length) return 0;
    let liveNames: Set<string>;
    try {
      liveNames = await this.livekit.listActiveRoomNames();
    } catch (err) {
      this.logger.warn(
        `reconcile: LiveKit недоступен, прогон пропущен (${err instanceof Error ? err.message : err})`,
      );
      return 0;
    }
    let closed = 0;
    for (const session of stale) {
      if (liveNames.has(session.roomName)) continue;
      await this.endSessionInternal(session, 'reconcile');
      closed++;
    }
    return closed;
  }

  // ---------- helpers ----------

  private assertEnabled(): void {
    if (!this.livekit.enabled) {
      throw new BadRequestException('Звонки не подключены (LIVEKIT_URL не задан)');
    }
  }

  private async requireModeratedSession(userId: string, sessionId: string): Promise<CallSession> {
    const session = await this.db.callSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'active') {
      throw new NotFoundException('Активная сессия звонка не найдена');
    }
    const resolver = this.registry.get(session.refType);
    if (!resolver || !(await resolver.canModerate(userId, session.refId))) {
      throw new ForbiddenException('Действие доступно только модератору звонка');
    }
    return session;
  }

  /**
   * Get-or-create активной сессии. Единственная защита от гонки двух первых токенов —
   * partial unique index call_sessions_one_active_per_ref (проигравший create падает
   * P2002 → перечитываем победителя).
   */
  private async ensureActiveSession(
    userId: string,
    refType: string,
    refId: string,
    resolver: CallsRefResolver,
  ): Promise<CallSession> {
    const existing = await this.db.callSession.findFirst({
      where: { refType, refId, status: 'active' },
    });
    if (existing) return existing;

    const id = randomUUID();
    try {
      const created = await this.db.callSession.create({
        data: {
          id,
          roomName: `call_${id}`,
          refType,
          refId,
          workspaceId: (await resolver.resolveWorkspaceId?.(refId)) ?? null,
          startedById: userId,
        },
      });
      this.events.emit('call.session.started', this.eventPayload(created), 'calls');
      return created;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.db.callSession.findFirst({
          where: { refType, refId, status: 'active' },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async endSessionInternal(
    session: CallSession,
    reason: string,
    endedById?: string,
  ): Promise<void> {
    // deleteRoom best-effort: БД — источник истины; комната могла уже умереть сама
    await this.livekit.deleteRoom(session.roomName);
    // Все строки журнала — до update: потребители классифицируют «пропущенный» (member
    // DM ∉ participants) и считают ДЛИТЕЛЬНОСТЬ от первого реального joinedAt (не от
    // старта дозвона) без чтения таблиц движка.
    const parts = await this.db.callSessionParticipant.findMany({
      where: { sessionId: session.id },
      select: { userId: true, joinedAt: true },
    });
    const endedAt = new Date();
    const done = await this.db.callSession.updateMany({
      where: { id: session.id, status: 'active' },
      data: { status: 'ended', endedAt },
    });
    if (done.count !== 1) return; // уже закрыта (второй вебхук/гонка) — идемпотентность
    await this.db.callSessionParticipant.updateMany({
      where: { sessionId: session.id, leftAt: null },
      data: { leftAt: endedAt },
    });
    const participantUserIds = [...new Set(parts.map((p) => p.userId))];
    const firstJoinedAt = parts.reduce<Date | null>(
      (min, p) => (min === null || p.joinedAt < min ? p.joinedAt : min),
      null,
    );
    this.events.emit(
      'call.session.ended',
      {
        ...this.eventPayload(session),
        reason,
        endedById: endedById ?? null,
        startedAt: session.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        // Момент, с которого считается длительность (первый вошедший; null = никто не зашёл)
        firstJoinedAt: firstJoinedAt ? firstJoinedAt.toISOString() : null,
        participantUserIds,
      },
      'calls',
    );
  }

  /** Обновить updatedAt сессии — маркер живости, чтобы реконсиляция не считала её stale */
  private async touchSession(sessionId: string): Promise<void> {
    await this.db.callSession
      .update({ where: { id: sessionId }, data: { updatedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Контекст в payload событий: потребители фильтруют свои по refType без запросов в БД */
  private eventPayload(session: CallSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      roomName: session.roomName,
      refType: session.refType,
      refId: session.refId,
      workspaceId: session.workspaceId,
      startedById: session.startedById,
    };
  }
}
