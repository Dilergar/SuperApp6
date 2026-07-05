'use client';

import type { FileDto } from '@superapp/shared';
import { useFileDisplayUrl } from '../../lib/hooks/useFileUrl';
import { fileIcon, formatDuration, hasVariant, humanSize } from './files-ui';

interface FileCardProps {
  file: FileDto;
  onOpen?: () => void;
  /** Слот под действия (удалить/переслать) — рендерится в нижней строке */
  actions?: React.ReactNode;
}

/**
 * Плитка файла для гридов (галерея вложений/фото): превью-вариант для
 * изображений/видео, крупная иконка для остального.
 */
export function FileCard({ file, onOpen, actions }: FileCardProps) {
  const previewVariant =
    file.kind === 'image' ? ('thumb' as const) : file.kind === 'video' ? ('poster' as const) : undefined;
  const showPreview = !!previewVariant && (file.kind === 'image' || hasVariant(file, 'poster'));
  const { url: previewUrl } = useFileDisplayUrl(showPreview ? file : null, previewVariant);
  const duration = formatDuration((file.meta as { durationMs?: number } | null)?.durationMs);

  return (
    <div
      style={{
        width: '10rem',
        background: 'var(--surface-container-lowest)',
        borderRadius: 'var(--radius-sketch)',
        overflow: 'hidden',
        boxShadow: '0 2px 6px rgba(56, 57, 45, 0.12)',
      }}
    >
      <div
        onClick={onOpen}
        style={{
          height: '6.5rem',
          background: 'var(--surface-container)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: onOpen ? 'pointer' : 'default',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={file.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ fontSize: '2.2rem' }}>{fileIcon(file.kind)}</span>
        )}
        {file.kind === 'video' && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.8rem',
              textShadow: '0 1px 6px rgba(0,0,0,0.5)',
            }}
          >
            ▶️
          </span>
        )}
        {duration && (
          <span
            style={{
              position: 'absolute',
              right: '0.35rem',
              bottom: '0.35rem',
              fontSize: '0.65rem',
              fontWeight: 700,
              color: '#fff',
              background: 'rgba(0,0,0,0.55)',
              padding: '0.05rem 0.35rem',
              borderRadius: '999px',
            }}
          >
            {duration}
          </span>
        )}
      </div>
      <div style={{ padding: '0.5rem 0.6rem 0.6rem' }}>
        <div
          title={file.name}
          style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            color: 'var(--on-surface)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {file.name}
        </div>
        <div
          style={{
            marginTop: '0.15rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.4rem',
          }}
        >
          <span style={{ fontSize: '0.68rem', color: 'var(--on-surface-variant)' }}>
            {humanSize(file.size)}
          </span>
          {actions}
        </div>
      </div>
    </div>
  );
}
