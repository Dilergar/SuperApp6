'use client';

import { CSSProperties, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { useCallEconomy } from './CallResilience';

/**
 * Панель управления звонком (низ комнаты): микрофон/камера/демонстрация экрана,
 * «Покинуть», модератору — «Завершить для всех». Glassmorphism по DESIGN.md.
 */
export function ControlsBar({
  moderator,
  onEndForAll,
  extra,
}: {
  moderator: boolean;
  /** Завершить созвон для всех (модератор) — зовёт движок POST /calls/rooms/:id/end */
  onEndForAll: () => void;
  /** Доп. кнопки справа (тумблеры панелей Участники/Чат) */
  extra?: React.ReactNode;
}) {
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();
  const { audioOnly, setAudioOnly } = useCallEconomy();
  const [busyShare, setBusyShare] = useState(false);

  const toggleMic = () => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  const toggleCam = () => void localParticipant.setCameraEnabled(!isCameraEnabled);
  const toggleShare = async () => {
    setBusyShare(true);
    try {
      // contentHint 'detail' — чёткость текста/слайдов важнее плавности (рычаг Meet-качества).
      // videoCodec VP8 — обязательный спутник VP9-дефолта комнаты: SVC-кодек для
      // screenshare принудил бы L1T3 + contentHint 'motion' и размыл текст
      await localParticipant.setScreenShareEnabled(
        !isScreenShareEnabled,
        { contentHint: 'detail' },
        { videoCodec: 'vp8' },
      );
    } catch {
      // пользователь закрыл системный пикер — не ошибка
    } finally {
      setBusyShare(false);
    }
  };

  const roundBtn = (active: boolean, danger = false): CSSProperties => ({
    width: '3rem',
    height: '3rem',
    borderRadius: '1rem 0.7rem 1.1rem 0.8rem',
    border: 'none',
    cursor: 'pointer',
    fontSize: '1.1rem',
    background: danger ? 'var(--primary)' : active ? 'var(--surface-container-high)' : 'var(--primary)',
    color: danger || !active ? 'white' : 'inherit',
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--spacing-3)',
        padding: 'var(--spacing-3) var(--spacing-4)',
        borderRadius: 'var(--radius-sketch)',
        background: 'color-mix(in srgb, var(--surface-container-lowest) 78%, transparent)',
        backdropFilter: 'blur(10px)',
        flexWrap: 'wrap',
      }}
    >
      <button onClick={toggleMic} title={isMicrophoneEnabled ? 'Выключить микрофон' : 'Включить микрофон'} style={roundBtn(isMicrophoneEnabled)}>
        {isMicrophoneEnabled ? '🎤' : '🔇'}
      </button>
      <button onClick={toggleCam} title={isCameraEnabled ? 'Выключить камеру' : 'Включить камеру'} style={roundBtn(isCameraEnabled)}>
        {isCameraEnabled ? '🎥' : '📷'}
      </button>
      <button
        onClick={toggleShare}
        disabled={busyShare}
        title={isScreenShareEnabled ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
        style={{
          ...roundBtn(true),
          background: isScreenShareEnabled ? 'var(--secondary)' : 'var(--surface-container-high)',
          color: isScreenShareEnabled ? 'white' : 'inherit',
        }}
      >
        🖥️
      </button>
      <button
        onClick={() => setAudioOnly(!audioOnly)}
        title={
          audioOnly
            ? 'Выключить режим «только звук» (вернуть видео участников)'
            : 'Режим «только звук» — экономия на слабой сети'
        }
        style={{
          ...roundBtn(true),
          background: audioOnly ? 'var(--secondary)' : 'var(--surface-container-high)',
          color: audioOnly ? 'white' : 'inherit',
        }}
      >
        🎧
      </button>

      <div style={{ width: 1 }} />

      <button className="btn-secondary" style={{ padding: '0.55rem 1.2rem', fontSize: '0.85rem' }} onClick={() => void room.disconnect()}>
        Покинуть
      </button>
      {moderator && (
        <button
          onClick={onEndForAll}
          style={{
            padding: '0.55rem 1.2rem',
            fontSize: '0.85rem',
            fontWeight: 700,
            border: 'none',
            cursor: 'pointer',
            borderRadius: '0.8rem 0.55rem 0.75rem 0.6rem',
            background: 'var(--primary)',
            color: 'white',
          }}
        >
          Завершить для всех
        </button>
      )}
      {extra}
    </div>
  );
}
