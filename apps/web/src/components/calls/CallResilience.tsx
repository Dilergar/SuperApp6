'use client';

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ConnectionQuality,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useConnectionQualityIndicator, useRoomContext } from '@livekit/components-react';

/**
 * Устойчивость к слабой сети (кит движка core/calls, общий для офиса и мессенджера):
 * эконом-режим «только звук» (ручной 🎧 + авто при устойчиво плохом качестве) и
 * баннеры/бейджи качества соединения. Механика — отписка от remote-камер через
 * setSubscribed(false): работает при включённом adaptiveStream (в отличие от
 * setVideoQuality/setEnabled), экономит и канал, и декодер. Screenshare не
 * отписываем — презентация важнее лица докладчика (паттерн Meet).
 */

type CallEconomyState = {
  /** Режим «только звук» активен */
  audioOnly: boolean;
  /** Кто включил: пользователь или автоматика (null — выключен) */
  source: 'manual' | 'auto' | null;
  /** Ручной тумблер (взводит manual override — авто больше не вмешивается) */
  setAudioOnly: (on: boolean) => void;
};

const CallEconomyContext = createContext<CallEconomyState | null>(null);

export function useCallEconomy(): CallEconomyState {
  const ctx = useContext(CallEconomyContext);
  if (!ctx) throw new Error('useCallEconomy: вне CallResilienceProvider');
  return ctx;
}

/** Порог авто-включения: Poor держится столько мс (Lost — сразу) */
const AUTO_POOR_DELAY_MS = 5000;
/** Автоскрытие тоста об авто-включении */
const AUTO_NOTICE_MS = 6000;

function Banner({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </div>
  );
}

export function CallResilienceProvider({
  localQuality,
  reconnecting,
  children,
}: {
  localQuality: ConnectionQuality;
  reconnecting: boolean;
  children: ReactNode;
}) {
  const room = useRoomContext();
  const [audioOnly, setAudioOnlyState] = useState(false);
  const [source, setSource] = useState<'manual' | 'auto' | null>(null);
  const [autoNotice, setAutoNotice] = useState(false);
  // Пользователь трогал тумблер сам → автоматика больше не переигрывает его решение
  const manualOverrideRef = useRef(false);
  const audioOnlyRef = useRef(false);
  audioOnlyRef.current = audioOnly;

  // Включить/выключить режим: отписка remote-камер (screenshare живёт) + своя камера off.
  // Повторные setSubscribed идемпотентны (StrictMode-даблмаунт безвреден).
  const apply = useCallback(
    (on: boolean) => {
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.videoTrackPublications.values()) {
          if (pub.source === Track.Source.Camera) pub.setSubscribed(!on);
        }
      }
      // Выход из режима камеру НЕ включает — пользователь решает сам
      if (on) void room.localParticipant.setCameraEnabled(false).catch(() => {});
    },
    [room],
  );

  const setAudioOnly = useCallback(
    (on: boolean) => {
      manualOverrideRef.current = true;
      setAutoNotice(false);
      setSource(on ? 'manual' : null);
      setAudioOnlyState(on);
      apply(on);
    },
    [apply],
  );

  // АВТО-включение: Lost → сразу; Poor устойчиво ≥5с → включить. Авто только
  // ВКЛЮЧАЕТ (авто-выхода нет — защита от флаппинга подписок при Poor↔Good;
  // деградация Meet тоже не откатывается сама). Выход — руками через 🎧.
  useEffect(() => {
    if (audioOnlyRef.current || manualOverrideRef.current) return;
    const enable = () => {
      setSource('auto');
      setAudioOnlyState(true);
      setAutoNotice(true);
      apply(true);
    };
    if (localQuality === ConnectionQuality.Lost) {
      enable();
      return;
    }
    if (localQuality === ConnectionQuality.Poor) {
      const t = setTimeout(enable, AUTO_POOR_DELAY_MS);
      return () => clearTimeout(t); // качество улучшилось раньше — таймер снят
    }
  }, [localQuality, apply]);

  useEffect(() => {
    if (!autoNotice) return;
    const t = setTimeout(() => setAutoNotice(false), AUTO_NOTICE_MS);
    return () => clearTimeout(t);
  }, [autoNotice]);

  // Страховки: новая камера при активном режиме тоже отписывается; после reconnect —
  // повторный sweep (UpdateSubscription, ушедший в разрыв, мог потеряться)
  useEffect(() => {
    const onPublished = (pub: RemoteTrackPublication) => {
      if (audioOnlyRef.current && pub.source === Track.Source.Camera) pub.setSubscribed(false);
    };
    const onReconnected = () => {
      if (audioOnlyRef.current) apply(true);
    };
    room.on(RoomEvent.TrackPublished, onPublished);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.TrackPublished, onPublished);
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [room, apply]);

  const qualityBad =
    localQuality === ConnectionQuality.Poor || localQuality === ConnectionQuality.Lost;

  return (
    <CallEconomyContext.Provider value={{ audioOnly, source, setAudioOnly }}>
      {/* Максимум один доп. баннер; Reconnecting-баннер шелла приоритетнее */}
      {autoNotice ? (
        <Banner>📶 Слабая сеть — включён режим «только звук» (видео вернёте кнопкой 🎧)</Banner>
      ) : qualityBad && !reconnecting && !audioOnly ? (
        <Banner>📶 Слабая сеть — качество может снижаться</Banner>
      ) : null}
      {children}
    </CallEconomyContext.Provider>
  );
}

/**
 * Бейдж качества соединения участника: показывается ТОЛЬКО при Poor/Lost
 * (Excellent/Good не спамим). Общий для MediaTile и ParticipantsPanel.
 */
export function ConnectionQualityBadge({ participant }: { participant: Participant }) {
  const { quality } = useConnectionQualityIndicator({ participant });
  if (quality !== ConnectionQuality.Poor && quality !== ConnectionQuality.Lost) return null;
  return (
    <span
      title={quality === ConnectionQuality.Lost ? 'Связь потеряна' : 'Слабая сеть у участника'}
      style={{ fontSize: '0.8rem' }}
    >
      📶
    </span>
  );
}
