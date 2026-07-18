'use client';

import { CSSProperties } from 'react';
import { Track } from 'livekit-client';
import {
  VideoTrack,
  useIsSpeaking,
  type TrackReference,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { ConnectionQualityBadge } from './CallResilience';

function isRealTrack(ref: TrackReferenceOrPlaceholder): ref is TrackReference {
  return 'publication' in ref && !!ref.publication;
}

/**
 * Тайл участника: видео (track), иначе PersonAvatar (принцип 2 — человек всегда
 * карточкой/аватаром со скином). Говорящий подсвечивается рамкой-«карандашом».
 */
export function MediaTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  const participant = trackRef.participant;
  const speaking = useIsSpeaking(participant);
  const micOn = participant.isMicrophoneEnabled;
  // isSubscribed обязателен: CallStage берёт треки с onlySubscribed:false, и камера,
  // отписанная эконом-режимом, без этой проверки давала бы чёрный тайл вместо аватара
  // (у локальной публикации isSubscribed всегда true — поведение не меняется)
  const videoOn =
    isRealTrack(trackRef) && !trackRef.publication.isMuted && trackRef.publication.isSubscribed;
  const name = participant.name || 'Участник';

  const tileStyle: CSSProperties = {
    position: 'relative',
    aspectRatio: '4 / 3',
    borderRadius: '1rem 0.7rem 1.1rem 0.8rem',
    overflow: 'hidden',
    background: 'var(--surface-container-high)',
    boxShadow: speaking ? '0 0 0 3px var(--secondary)' : 'none',
    transition: 'box-shadow 0.15s ease',
  };

  return (
    <div style={tileStyle}>
      {videoOn ? (
        <VideoTrack
          trackRef={trackRef as TrackReference}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            // Своё зеркало — как в превью (удалённых не зеркалим)
            transform: participant.isLocal ? 'scaleX(-1)' : undefined,
          }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PersonAvatar userId={participant.identity} name={name} size="lg" />
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          left: 'var(--spacing-2)',
          bottom: 'var(--spacing-2)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
          background: 'rgba(56, 57, 45, 0.62)',
          color: '#fdffda',
          padding: '0.15rem 0.6rem',
          borderRadius: '0.6rem 0.4rem 0.55rem 0.45rem',
          fontSize: '0.75rem',
          fontWeight: 600,
          maxWidth: 'calc(100% - 1rem)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {!micOn && <span title="Микрофон выключен">🔇</span>}
        <ConnectionQualityBadge participant={participant} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}
          {participant.isLocal ? ' (вы)' : ''}
        </span>
      </div>
    </div>
  );
}

/** Крупный тайл демонстрации экрана (доминирует в раскладке; contain — читаемость текста) */
export function ScreenShareTile({ trackRef }: { trackRef: TrackReference }) {
  const name = trackRef.participant.name || 'Участник';
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        borderRadius: '1rem 0.7rem 1.1rem 0.8rem',
        overflow: 'hidden',
        background: '#22231b',
      }}
    >
      <VideoTrack trackRef={trackRef} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      <div
        style={{
          position: 'absolute',
          left: 'var(--spacing-2)',
          top: 'var(--spacing-2)',
          background: 'rgba(56, 57, 45, 0.62)',
          color: '#fdffda',
          padding: '0.15rem 0.6rem',
          borderRadius: '0.6rem 0.4rem 0.55rem 0.45rem',
          fontSize: '0.75rem',
          fontWeight: 600,
        }}
      >
        🖥️ Демонстрация — {name}
      </div>
    </div>
  );
}

export { Track };
