'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import {
  AudioPresets,
  ConnectionQuality,
  DisconnectReason,
  Room,
  RoomEvent,
  type Participant,
  type VideoCodec,
} from 'livekit-client';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import { CallResilienceProvider } from './CallResilience';

// Основной видеокодек звонков: VP9 = SVC (scalabilityMode L3T3_KEY автоматом) — SFU
// плавно сбрасывает слои слабым получателям (техника Meet); Safari/несовместимые
// получают VP8-дубль через backupCodec. Откат при жалобах на CPU слабых машин —
// поменять на 'vp8' (один флаг, всё остальное независимо).
const CALL_VIDEO_CODEC: VideoCodec = 'vp9';

export type CallLeaveReason = 'left' | 'ended' | 'kicked' | 'error';

/**
 * Обёртка живого звонка (переиспользуемый кит движка core/calls): создаёт Room
 * с полным набором техник устойчивости Meet — adaptiveStream+dynacast (адаптивные
 * слои по размеру тайла + пауза невидимых), Opus RED+DTX, VP9 SVC (+VP8-backup),
 * simulcast, speech-пресет аудио; слушает качество соединения и оборачивает детей
 * в CallResilienceProvider (баннер «Слабая сеть» + эконом-режим «только звук»).
 * UI внутри — полностью наш (DESIGN.md); RoomAudioRenderer — единственный
 * служебный компонент (кросс-браузерное аудио).
 *
 * Room создаётся ВНУТРИ эффекта (свой инстанс на каждый mount): в dev React
 * StrictMode монтирует эффект дважды — события первого (уже отключённого)
 * инстанса не должны ронять соединение второго.
 */
export function CallRoomShell({
  token,
  wsUrl,
  audioEnabled,
  videoEnabled,
  audioDeviceId,
  videoDeviceId,
  onLeft,
  children,
}: {
  token: string;
  wsUrl: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
  onLeft: (reason: CallLeaveReason) => void;
  children: ReactNode;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [localQuality, setLocalQuality] = useState<ConnectionQuality>(ConnectionQuality.Unknown);
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;

  useEffect(() => {
    let cancelled = false;
    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        deviceId: audioDeviceId,
        // Клиентский шумодав браузера (как в useVoiceRecorder)
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
      videoCaptureDefaults: { deviceId: videoDeviceId },
      // Устойчивость к слабой сети (техники Meet). red/dtx/simulcast/backupCodec —
      // дефолты livekit-client, зафиксированы явно как несущая конфигурация.
      publishDefaults: {
        red: true, // Opus RED: 2x-дублирование аудио-кадров — речь разборчива при потерях
        dtx: true, // тишина не тратит канал
        simulcast: true, // слои для VP8-пути/backup-кодека
        videoCodec: CALL_VIDEO_CODEC,
        backupCodec: true, // авто-VP8 для подписчиков без VP9 (Safari)
        // 24 kbps (с RED ~×2): звонок = речь; дефолтный music 48k на слабом канале лишний
        audioPreset: AudioPresets.speech,
      },
    });
    setRoom(r);

    const handleDisconnected = (reason?: DisconnectReason) => {
      if (cancelled) return;
      if (reason === DisconnectReason.ROOM_DELETED) onLeftRef.current('ended');
      else if (reason === DisconnectReason.PARTICIPANT_REMOVED) onLeftRef.current('kicked');
      else if (reason === DisconnectReason.CLIENT_INITIATED) onLeftRef.current('left');
      else onLeftRef.current('error');
    };
    const handleReconnecting = () => setReconnecting(true);
    const handleReconnected = () => setReconnecting(false);
    // Качество СВОЕГО соединения (Excellent/Good/Poor/Lost) — кормит баннер
    // «Слабая сеть» и авто-эконом-режим в CallResilienceProvider
    const handleQuality = (q: ConnectionQuality, p: Participant) => {
      if (!cancelled && p.isLocal) setLocalQuality(q);
    };

    r.on(RoomEvent.Disconnected, handleDisconnected);
    r.on(RoomEvent.Reconnecting, handleReconnecting);
    r.on(RoomEvent.Reconnected, handleReconnected);
    r.on(RoomEvent.ConnectionQualityChanged, handleQuality);

    void (async () => {
      // Прогрев DNS/TCP/TLS до сигнального WS (не бросает никогда; на localhost ~0,
      // в проде экономит сотни мс холодного старта)
      await r.prepareConnection(wsUrl, token);
      if (cancelled) return;
      try {
        await r.connect(wsUrl, token);
      } catch {
        if (!cancelled) onLeftRef.current('error');
        return;
      }
      if (cancelled) return;
      // Публикация по выбору prejoin — после connect (вход быстрее). Ошибка устройства
      // (нет камеры/запретили доступ) НЕ рушит звонок — входишь слушателем, как в Meet.
      await r.localParticipant.setMicrophoneEnabled(audioEnabled).catch(() => {});
      await r.localParticipant.setCameraEnabled(videoEnabled).catch(() => {});
    })();

    return () => {
      cancelled = true;
      r.off(RoomEvent.Disconnected, handleDisconnected);
      r.off(RoomEvent.Reconnecting, handleReconnecting);
      r.off(RoomEvent.Reconnected, handleReconnected);
      r.off(RoomEvent.ConnectionQualityChanged, handleQuality);
      void r.disconnect();
    };
    // Параметры входа фиксируются prejoin'ом на mount — пересоздание Room не нужно
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!room) return null;

  return (
    <RoomContext.Provider value={room}>
      <RoomAudioRenderer />
      {reconnecting && (
        <div
          className="wash-secondary"
          style={{
            padding: 'var(--spacing-2) var(--spacing-4)',
            marginBottom: 'var(--spacing-3)',
            fontSize: '0.85rem',
            color: 'var(--secondary)',
            fontWeight: 600,
          }}
        >
          Переподключение… звонок восстановится сам
        </div>
      )}
      <CallResilienceProvider localQuality={localQuality} reconnecting={reconnecting}>
        {children}
      </CallResilienceProvider>
    </RoomContext.Provider>
  );
}
