'use client';

import { useRef, useState } from 'react';
import { IMAGE_MIME } from '@superapp/shared';
import { getFileMeta, uploadFile } from '../../lib/files-api';
import { hasVariant } from './files-ui';

interface AvatarUploadBlockProps {
  /** Текущий URL (внешний или наш publicUrl) */
  current: string | null;
  /** Фолбэк, когда картинки нет: инициал/emoji */
  fallback: string;
  shape?: 'circle' | 'square';
  /** Лого организации — файл во владение workspace */
  ownerWorkspaceId?: string;
  label?: string;
  /** null = удалить */
  onSaved: (url: string | null) => Promise<void> | void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Переиспользуемый блок «аватарка/лого»: превью + загрузка через движок файлов
 * (профиль 'avatar' — публичный класс, вечная ссылка) + удаление. Без кропа (v1):
 * карточки показывают картинку с object-fit cover. После загрузки ждём thumb-вариант
 * (генерится асинхронно) и сохраняем ссылку на него; не дождались — оригинал (К-4).
 */
export function AvatarUploadBlock({
  current,
  fallback,
  shape = 'circle',
  ownerWorkspaceId,
  label = 'Фото',
  onSaved,
}: AvatarUploadBlockProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const pick = () => !busy && inputRef.current?.click();

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    setProgress(0);
    try {
      const dto = await uploadFile(file, 'avatar', {
        ownerWorkspaceId,
        onProgress: (fr) => setProgress(fr),
      });
      // thumb генерится асинхронно — коротко ждём его, чтобы сохранить лёгкую ссылку
      let url = dto.publicUrl ?? '';
      for (let i = 0; i < 10 && url; i++) {
        const fresh = await getFileMeta(dto.id).catch(() => null);
        if (fresh && hasVariant(fresh, 'thumb')) {
          url = `${fresh.publicUrl}?variant=thumb`;
          break;
        }
        await sleep(700);
      }
      if (!url) throw new Error('Файл не получил публичную ссылку');
      await onSaved(url);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      setError(e?.response?.data?.message ?? e?.message ?? 'Ошибка загрузки');
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSaved(null);
    } finally {
      setBusy(false);
    }
  };

  const radius = shape === 'circle' ? '50%' : 'var(--radius-sketch)';

  return (
    <div>
      {label && (
        <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>
          {label}
        </label>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)' }}>
        <div
          onClick={pick}
          role="button"
          aria-label="Загрузить фото"
          style={{
            width: 84,
            height: 84,
            borderRadius: radius,
            overflow: 'hidden',
            flexShrink: 0,
            cursor: busy ? 'wait' : 'pointer',
            background: 'var(--surface-container-high)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: '2rem', fontFamily: 'var(--font-display)', color: 'var(--on-surface-variant)' }}>
              {fallback}
            </span>
          )}
          {busy && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(56,57,45,0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: '0.75rem',
                fontWeight: 700,
              }}
            >
              {progress > 0 && progress < 1 ? `${Math.round(progress * 100)}%` : '…'}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          <button type="button" className="btn-secondary" onClick={pick} disabled={busy} style={{ fontSize: '0.8rem' }}>
            {current ? 'Заменить' : 'Загрузить'}
          </button>
          {current && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--danger)',
                fontSize: '0.75rem',
                cursor: 'pointer',
                textAlign: 'left',
                padding: 0,
              }}
            >
              Удалить
            </button>
          )}
        </div>
      </div>
      {error && (
        <div style={{ marginTop: 'var(--spacing-2)', color: 'var(--danger)', fontSize: '0.75rem' }}>{error}</div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_MIME.join(',')}
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
