'use client';

import type { FileDto } from '@superapp/shared';
import { useFileDisplayUrl } from '../../lib/hooks/useFileUrl';
import { formatDuration } from './files-ui';

interface AudioPlayerProps {
  file: FileDto;
}

/** Аудио/голосовое из движка файлов (Range/206 → перемотка нативная) */
export function AudioPlayer({ file }: AudioPlayerProps) {
  const { url } = useFileDisplayUrl(file);
  const duration = formatDuration((file.meta as { durationMs?: number } | null)?.durationMs);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        padding: '0.4rem 0.6rem',
        background: 'var(--surface-container)',
        borderRadius: 'var(--radius-sketch)',
        maxWidth: '24rem',
      }}
    >
      {url ? (
        <audio controls preload="metadata" src={url} style={{ width: '100%', height: '2rem' }} />
      ) : (
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>Загружаю…</span>
      )}
      {duration && (
        <span style={{ fontSize: '0.7rem', color: 'var(--on-surface-variant)', flexShrink: 0 }}>
          {duration}
        </span>
      )}
    </div>
  );
}
