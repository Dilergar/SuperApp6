'use client';

import { useEffect } from 'react';
import type { FileDto } from '@superapp/shared';
import { useFileDisplayUrl } from '../../lib/hooks/useFileUrl';
import { hasVariant, humanSize } from './files-ui';

interface ImageLightboxProps {
  file: FileDto;
  onClose: () => void;
}

/** Полноэкранный просмотр изображения (medium-вариант, если есть; Esc/клик — закрыть) */
export function ImageLightbox({ file, onClose }: ImageLightboxProps) {
  const variant = hasVariant(file, 'medium') ? ('medium' as const) : undefined;
  const { url, isLoading } = useFileDisplayUrl(file, variant);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'rgba(30, 28, 20, 0.82)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        cursor: 'zoom-out',
      }}
    >
      {isLoading || !url ? (
        <div style={{ color: '#fff', fontFamily: 'var(--font-body)' }}>Загружаю…</div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          onClick={(e) => e.stopPropagation()}
          style={{
            maxWidth: '92vw',
            maxHeight: '82vh',
            objectFit: 'contain',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 40px rgba(56, 57, 45, 0.5)',
            cursor: 'default',
          }}
        />
      )}
      <div
        style={{
          marginTop: '0.9rem',
          color: 'rgba(255,255,255,0.85)',
          fontSize: '0.8rem',
          fontFamily: 'var(--font-body)',
          maxWidth: '80vw',
          textAlign: 'center',
        }}
      >
        {file.name} · {humanSize(file.size)}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        style={{
          position: 'fixed',
          top: '1rem',
          right: '1.25rem',
          border: 'none',
          background: 'rgba(255,255,255,0.12)',
          color: '#fff',
          fontSize: '1.1rem',
          width: '2.2rem',
          height: '2.2rem',
          borderRadius: '999px',
          cursor: 'pointer',
        }}
      >
        ✕
      </button>
    </div>
  );
}
