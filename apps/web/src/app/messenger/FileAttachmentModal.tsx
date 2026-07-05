'use client';

import { useEffect, useRef, useState } from 'react';
import { MESSENGER_LIMITS } from '@superapp/shared';
import type { FileDto } from '@superapp/shared';
import { useFileUpload } from '@/lib/hooks/useFileUpload';
import { deleteFile } from '@/lib/files-api';
import { FileDropzone } from '@/components/files/FileDropzone';
import { UploadProgressList } from '@/components/files/UploadProgressList';
import { FileChip } from '@/components/files/FileChip';

// ============================================================
// Ф9 (вложения): модалка «Прикрепить файлы» из композера — дропзона
// (drag&drop + Ctrl+V) → движок файлов (профиль chat_attachment) →
// подпись → одно attachment-сообщение (альбом до 10 файлов).
// ============================================================

export function FileAttachmentModal({
  onSend,
  onClose,
}: {
  onSend: (files: FileDto[], caption: string) => void;
  onClose: () => void;
}) {
  const [ready, setReady] = useState<FileDto[]>([]);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');

  const max = MESSENGER_LIMITS.maxAttachmentsPerMessage;

  const uploader = useFileUpload('chat_attachment', {
    onUploaded: (file) => {
      setReady((prev) => {
        // Сверх лимита файл не показываем И удаляем с сервера (иначе осиротевшая квота)
        if (prev.length >= max) {
          deleteFile(file.id).catch(() => undefined);
          return prev;
        }
        return [...prev, file];
      });
    },
  });

  // Незакреплённые загрузки (закрыли модалку без отправки) — прибрать, не мусорить квоту
  const committedRef = useRef(false);
  const readyRef = useRef<FileDto[]>([]);
  readyRef.current = ready;
  useEffect(() => {
    return () => {
      if (!committedRef.current) {
        for (const f of readyRef.current) deleteFile(f.id).catch(() => undefined);
      }
    };
  }, []);

  const removeReady = (fileId: string) => {
    deleteFile(fileId).catch(() => undefined); // готовый файл на сервере тоже убираем
    setReady((prev) => prev.filter((f) => f.id !== fileId));
  };

  const submit = () => {
    if (!ready.length || uploader.busy) return;
    if (ready.length > max) {
      setError(`Не больше ${max} файлов в одном сообщении`);
      return;
    }
    committedRef.current = true; // файлы уходят в сообщение — не удалять при закрытии
    onSend(ready, caption.trim());
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(56,57,45,0.35)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{
          background: 'var(--surface-container-low)',
          padding: 'var(--spacing-6)',
          maxWidth: 460,
          width: '100%',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-4)',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 className="title-md">Прикрепить файлы</h3>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1rem' }}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        <FileDropzone
          onFiles={(fs) => {
            setError('');
            // Комната = лимит − готовые − ещё грузящиеся (иначе можно накидать сверх лимита,
            // пока идёт загрузка, и лишние файлы осиротеют на сервере)
            const inFlight = uploader.items.filter((i) => i.status === 'uploading').length;
            const room = max - ready.length - inFlight;
            if (fs.length > room) {
              setError(`Не больше ${max} файлов в одном сообщении`);
            }
            uploader.add(fs.slice(0, Math.max(0, room)));
          }}
          paste
          multiple
          compact
          label="Файлы, фото, видео, документы"
        />

        <UploadProgressList items={uploader.items.filter((i) => i.status !== 'done')} onCancel={uploader.cancel} onRemove={uploader.remove} />

        {ready.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
            {ready.map((f) => (
              <FileChip key={f.id} file={f} onRemove={() => removeReady(f.id)} />
            ))}
          </div>
        )}

        <input
          type="text"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          className="input-sketch"
          placeholder="Подпись (необязательно)"
          maxLength={MESSENGER_LIMITS.maxMessageLength}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />

        {error && <div style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>{error}</div>}

        <button
          type="button"
          className="btn-primary"
          onClick={submit}
          disabled={!ready.length || uploader.busy}
          style={{ opacity: !ready.length || uploader.busy ? 0.6 : 1 }}
        >
          {uploader.busy ? 'Загрузка…' : `Отправить${ready.length ? ` (${ready.length})` : ''}`}
        </button>
      </div>
    </div>
  );
}
