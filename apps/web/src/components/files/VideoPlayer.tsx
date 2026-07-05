'use client';

import type { FileDto } from '@superapp/shared';
import { useFileDisplayUrl } from '../../lib/hooks/useFileUrl';
import { hasVariant } from './files-ui';

interface VideoPlayerProps {
  file: FileDto;
  maxWidth?: string;
}

/**
 * Видео из движка файлов: постер-кадр из конвейера + нативный <video>
 * (перемотка работает — сервер отдаёт Range/206).
 */
export function VideoPlayer({ file, maxWidth = '30rem' }: VideoPlayerProps) {
  const { url } = useFileDisplayUrl(file);
  const posterAvailable = hasVariant(file, 'poster');
  const { url: posterUrl } = useFileDisplayUrl(posterAvailable ? file : null, 'poster');

  if (!url) {
    return (
      <div
        style={{
          maxWidth,
          aspectRatio: '16 / 9',
          background: 'var(--surface-container)',
          borderRadius: 'var(--radius-sketch)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--on-surface-variant)',
          fontSize: '0.8rem',
        }}
      >
        Загружаю видео…
      </div>
    );
  }

  return (
    <video
      controls
      preload="metadata"
      src={url}
      poster={posterUrl ?? undefined}
      style={{
        maxWidth,
        width: '100%',
        borderRadius: 'var(--radius-sketch)',
        background: '#000',
        display: 'block',
      }}
    />
  );
}
