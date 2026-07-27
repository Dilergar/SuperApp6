'use client';

// ============================================================
// Очередь загрузок (пара к useFileUpload).
//
// Вид — по дизайн-пакету: строка файла с иконкой в матовом квадрате,
// прогресс — ФИРМЕННЫЙ штриховой бар с градиентом красный→зелёный
// («путь от нуля к готово»), завершённая строка — зелёная иконка
// и подпись капсом «N МБ · ГОТОВО».
// ============================================================

import type { UploadItem } from '../../lib/hooks/useFileUpload';
import { humanSize } from './files-ui';
import { GradientTickBar, Icon, IconButton, toneVars, type IconName, type Tone } from '@/components/ui';

/** Вид файла → иконка кита (эмодзи здесь не место: это интерфейс). */
const KIND_ICON: Record<string, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'speaker',
  document: 'file',
  archive: 'folder',
  other: 'file',
};

interface UploadProgressListProps {
  items: UploadItem[];
  onCancel: (localId: string) => void;
  onRemove: (localId: string) => void;
}

export function UploadProgressList({ items, onCancel, onRemove }: UploadProgressListProps) {
  if (!items.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {items.map((item) => {
        const pct = Math.round(item.progress * 100);
        const uploading = item.status === 'uploading';
        const tone: Tone =
          item.status === 'error' ? 'danger'
            : item.status === 'done' ? 'success'
              : item.status === 'cancelled' ? 'neutral'
                : 'accent';
        const statusText =
          item.status === 'done' ? 'Готово'
            : item.status === 'cancelled' ? 'Отменено'
              : item.status === 'error' ? (item.error ?? 'Ошибка')
                : null;

        return (
          <div
            key={item.localId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              padding: '0.625rem 0.75rem',
              border: '1px solid var(--divider)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--block)',
            }}
          >
            <span
              style={{
                ...toneVars(tone),
                width: 34, height: 34, minWidth: 34,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--tone-bg)', border: '1px solid var(--tone-border)', color: 'var(--tone-fg)',
              }}
            >
              <Icon name={KIND_ICON[item.file?.kind ?? 'other'] ?? 'file'} size={17} />
            </span>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                title={item.name}
                className="title-sm"
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {item.name}
              </div>

              {uploading ? (
                <div style={{ marginTop: '0.375rem' }}>
                  <GradientTickBar value={pct} direction="red-green" height={8} />
                </div>
              ) : (
                <div className="label-caps" style={{ ...toneVars(tone), marginTop: '0.2rem', color: 'var(--tone-fg)' }}>
                  {humanSize(item.size)}{statusText ? ` · ${statusText}` : ''}
                </div>
              )}
            </div>

            {uploading && <span className="meta" style={{ color: 'var(--muted)' }}>{pct}%</span>}

            <IconButton
              icon="close"
              label={uploading ? 'Отменить загрузку' : 'Убрать из списка'}
              size={28}
              onClick={() => (uploading ? onCancel(item.localId) : onRemove(item.localId))}
            />
          </div>
        );
      })}
    </div>
  );
}
