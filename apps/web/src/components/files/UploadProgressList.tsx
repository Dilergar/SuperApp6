'use client';

import type { UploadItem } from '../../lib/hooks/useFileUpload';
import { fileIcon, humanSize } from './files-ui';

interface UploadProgressListProps {
  items: UploadItem[];
  onCancel: (localId: string) => void;
  onRemove: (localId: string) => void;
}

/** Очередь загрузок с прогрессом (пара к useFileUpload) */
export function UploadProgressList({ items, onCancel, onRemove }: UploadProgressListProps) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((item) => {
        const pct = Math.round(item.progress * 100);
        const statusText =
          item.status === 'uploading'
            ? `${pct}%`
            : item.status === 'done'
              ? 'Готово'
              : item.status === 'cancelled'
                ? 'Отменено'
                : (item.error ?? 'Ошибка');
        const statusColor =
          item.status === 'error'
            ? 'var(--danger)'
            : item.status === 'done'
              ? 'var(--success)'
              : 'var(--on-surface-variant)';
        return (
          <div
            key={item.localId}
            style={{
              padding: '0.45rem 0.6rem',
              background: 'var(--surface-container-low)',
              borderRadius: 'var(--radius-sketch)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.95rem' }}>{fileIcon(item.file?.kind ?? 'other')}</span>
              <span
                title={item.name}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.name}
              </span>
              <span style={{ fontSize: '0.68rem', color: 'var(--on-surface-variant)' }}>
                {humanSize(item.size)}
              </span>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: statusColor }}>{statusText}</span>
              {item.status === 'uploading' ? (
                <button
                  type="button"
                  onClick={() => onCancel(item.localId)}
                  title="Отменить"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  ✕
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onRemove(item.localId)}
                  title="Убрать из списка"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    color: 'var(--on-surface-variant)',
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            {item.status === 'uploading' && (
              <div
                style={{
                  marginTop: '0.35rem',
                  height: 5,
                  background: 'var(--surface-container-high)',
                  borderRadius: 999,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: 'var(--secondary)',
                    borderRadius: 999,
                    transition: 'width 0.2s ease',
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
