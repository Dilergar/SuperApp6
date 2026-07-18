import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  WebhookReceiver,
  type EgressInfo,
} from 'livekit-server-sdk';

/**
 * Обвязка LiveKit (паттерн voice-stt.client): инертность на env-геттерах, ленивые
 * клиенты SDK. Токен подписывается ЛОКАЛЬНО (HMAC ключом API, сеть не нужна) —
 * verify-скрипты работают без живого сервера. Семантика ошибок двухуровневая:
 * наша БД — источник истины о сессиях, поэтому deleteRoom — best-effort (warn),
 * а модерация (kick/mute) наоборот БРОСАЕТ при недоступности — «исключил» не
 * должно фиктивно срабатывать.
 */

export interface MintTokenOptions {
  /** identity LiveKit = наш userId (веб рисует PersonAvatar по нему) */
  identity: string;
  name: string;
  roomName: string;
  moderator: boolean;
  ttlSec: number;
}

@Injectable()
export class CallsLivekitClient {
  private readonly logger = new Logger(CallsLivekitClient.name);
  private roomServiceInstance: RoomServiceClient | null = null;
  private receiverInstance: WebhookReceiver | null = null;
  private egressInstance: EgressClient | null = null;

  get enabled(): boolean {
    return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  }

  /**
   * Запись включена: рядом с LiveKit поднят egress-контейнер, а его выходной каталог
   * (bind-mount, общий с хост-API) задан в LIVEKIT_EGRESS_DIR. Без него кнопка ⏺ скрыта.
   */
  get recordingEnabled(): boolean {
    return this.enabled && !!process.env.LIVEKIT_EGRESS_DIR;
  }

  /** Хост-путь выходного каталога egress (bind-mount ./apps/api/storage/egress ↔ /out) */
  get egressDir(): string | null {
    return process.env.LIVEKIT_EGRESS_DIR || null;
  }

  /** ws-адрес для браузера: LIVEKIT_WS_URL или LIVEKIT_URL с заменой http→ws */
  get wsUrl(): string | null {
    if (!this.enabled) return null;
    if (process.env.LIVEKIT_WS_URL) return process.env.LIVEKIT_WS_URL;
    return (process.env.LIVEKIT_URL as string).replace(/^http/, 'ws');
  }

  /** Токен входа в комнату — локальная подпись, живой сервер не нужен */
  async mintToken(opts: MintTokenOptions): Promise<string> {
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: opts.identity,
      name: opts.name,
      ttl: opts.ttlSec,
    });
    at.addGrant({
      roomJoin: true,
      room: opts.roomName,
      canPublish: true,
      canSubscribe: true,
      // roomAdmin: модерация на стороне LiveKit (наши kick/mute идут серверным API,
      // но админ-грант позволяет и клиентские RoomService-вызовы будущих фич)
      roomAdmin: opts.moderator,
    });
    return at.toJwt();
  }

  /** Верификатор подписи вебхуков (JWT в Authorization несёт sha256 сырого тела) */
  get webhookReceiver(): WebhookReceiver {
    if (!this.receiverInstance) {
      this.receiverInstance = new WebhookReceiver(
        process.env.LIVEKIT_API_KEY as string,
        process.env.LIVEKIT_API_SECRET as string,
      );
    }
    return this.receiverInstance;
  }

  private get roomService(): RoomServiceClient {
    if (!this.roomServiceInstance) {
      this.roomServiceInstance = new RoomServiceClient(
        process.env.LIVEKIT_URL as string,
        process.env.LIVEKIT_API_KEY as string,
        process.env.LIVEKIT_API_SECRET as string,
      );
    }
    return this.roomServiceInstance;
  }

  /**
   * Удалить комнату (участники получают Disconnected/ROOM_DELETED). Best-effort:
   * недоступный LiveKit не блокирует закрытие сессии в БД — пустая комната сама
   * умрёт по empty_timeout, а реконсиляция-крон подчистит хвосты.
   */
  async deleteRoom(roomName: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.roomService.deleteRoom(roomName);
      return true;
    } catch (err) {
      this.logger.warn(`deleteRoom ${roomName}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Имена живых комнат (крон-реконсиляция). БРОСАЕТ при недоступности — вызывающий пропускает прогон. */
  async listActiveRoomNames(): Promise<Set<string>> {
    const rooms = await this.roomService.listRooms();
    return new Set(rooms.map((r) => r.name));
  }

  /** Исключить участника. Бросает 502 при недоступности/отсутствии — модерация не «врёт». */
  async removeParticipant(roomName: string, identity: string): Promise<void> {
    try {
      await this.roomService.removeParticipant(roomName, identity);
    } catch (err) {
      throw new BadGatewayException(
        `Не удалось исключить участника: ${err instanceof Error ? err.message : 'LiveKit недоступен'}`,
      );
    }
  }

  /** Принудительный mute опубликованного трека участника. Бросает 502 при недоступности. */
  async mutePublishedTrack(roomName: string, identity: string, trackSid: string, muted: boolean): Promise<void> {
    try {
      await this.roomService.mutePublishedTrack(roomName, identity, trackSid, muted);
    } catch (err) {
      throw new BadGatewayException(
        `Не удалось изменить mute: ${err instanceof Error ? err.message : 'LiveKit недоступен'}`,
      );
    }
  }

  // ---------- Запись (LiveKit Egress) ----------

  private get egress(): EgressClient {
    if (!this.egressInstance) {
      this.egressInstance = new EgressClient(
        process.env.LIVEKIT_URL as string,
        process.env.LIVEKIT_API_KEY as string,
        process.env.LIVEKIT_API_SECRET as string,
      );
    }
    return this.egressInstance;
  }

  /**
   * Стартовать аудио-запись комнаты (RoomComposite audioOnly → OGG/opus в файл
   * внутри egress-контейнера; /out — bind-mount на LIVEKIT_EGRESS_DIR хоста).
   * Бросает 502 при недоступности egress'а — «запись включена» не должно врать.
   */
  async startAudioEgress(roomName: string, fileBasename: string): Promise<EgressInfo> {
    try {
      const output = new EncodedFileOutput({
        fileType: EncodedFileType.OGG,
        filepath: `/out/${fileBasename}`,
      });
      return await this.egress.startRoomCompositeEgress(roomName, output, { audioOnly: true });
    } catch (err) {
      throw new BadGatewayException(
        `Не удалось начать запись: ${err instanceof Error ? err.message : 'egress недоступен'}`,
      );
    }
  }

  /** Остановить egress. Уже завершён/не найден → no-op (финализирует вебхук egress_ended). */
  async stopEgress(egressId: string): Promise<void> {
    try {
      await this.egress.stopEgress(egressId);
    } catch (err) {
      this.logger.warn(`stopEgress ${egressId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Статус egress'а (крон-редрайв потерянного egress_ended). Бросает при недоступности. */
  async getEgressInfo(egressId: string): Promise<EgressInfo | null> {
    const list = await this.egress.listEgress({ egressId });
    return list[0] ?? null;
  }
}
