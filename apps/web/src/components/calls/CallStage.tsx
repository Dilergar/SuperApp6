'use client';

import { Track } from 'livekit-client';
import { useTracks, type TrackReference } from '@livekit/components-react';
import { MediaTile, ScreenShareTile } from './MediaTile';

/**
 * Сцена звонка (кит движка core/calls, общий для офиса и мессенджера):
 * демонстрация экрана доминирует, иначе адаптивный грид камер-тайлов
 * (MediaTile рисует PersonAvatar, когда видео выключено — аудио-звонок).
 */
export function CallStage() {
  const camTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  const screenTracks = useTracks([Track.Source.ScreenShare]);
  const screen = (screenTracks[0] as TrackReference | undefined) ?? null;

  if (screen) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 'var(--spacing-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ScreenShareTile trackRef={screen} />
        </div>
        <div style={{ width: 180, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {camTracks.map((t) => (
            <MediaTile key={`${t.participant.identity}:${t.publication?.trackSid ?? 'ph'}`} trackRef={t} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 'var(--spacing-3)',
        alignContent: 'start',
      }}
    >
      {camTracks.map((t) => (
        <MediaTile key={`${t.participant.identity}:${t.publication?.trackSid ?? 'ph'}`} trackRef={t} />
      ))}
    </div>
  );
}
