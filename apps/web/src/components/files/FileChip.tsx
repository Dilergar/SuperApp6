'use client';

import { useState } from 'react';
import type { FileDto } from '@superapp/shared';
import { getDownloadUrl } from '../../lib/files-api';
import { fileIcon, humanSize } from './files-ui';

interface FileChipProps {
  file: Pick<FileDto, 'id' | 'name' | 'size' | 'kind' | 'mime' | 'status'>;
  onRemove?: () => void;
  onClick?: () => void;
}

/**
 * Компактная строка-файл (вложение в чате/задаче/форме): иконка типа, имя,
 * размер, скачивание. Аналог PersonChip, но для файлов.
 */
export function FileChip({ file, onRemove, onClick }: FileChipProps) {
  const [busy, setBusy] = useState(false);

  const download = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || file.status !== 'ready') return;
    setBusy(true);
    try {
      const { url } = await getDownloadUrl(file.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      a.click();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        maxWidth: '100%',
        padding: '0.35rem 0.6rem',
        background: 'var(--surface-container)',
        borderRadius: 'var(--radius-sketch)',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ fontSize: '1rem', lineHeight: 1 }}>{fileIcon(file.kind)}</span>
      <span
        style={{
          fontSize: '0.8rem',
          fontWeight: 600,
          color: 'var(--on-surface)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '14rem',
        }}
        title={file.name}
      >
        {file.name}
      </span>
      <span style={{ fontSize: '0.7rem', color: 'var(--on-surface-variant)', flexShrink: 0 }}>
        {humanSize(file.size)}
      </span>
      {file.status === 'ready' && (
        <button
          type="button"
          onClick={download}
          disabled={busy}
          title="Скачать"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '0.85rem',
            lineHeight: 1,
            padding: '0.1rem',
            opacity: busy ? 0.4 : 0.8,
          }}
        >
          ⬇️
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Убрать"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '0.8rem',
            lineHeight: 1,
            padding: '0.1rem',
            color: 'var(--on-surface-variant)',
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
