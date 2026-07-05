'use client';

// ============================================================
// Дев-полигон движка файлов (core/files). ТОЛЬКО development:
// в проде роут отдаёт 404, из навигации никуда не линкуется
// (правило «no placeholder UI»). Здесь визуально проверяются
// кирпичи веб-кита до подключения настоящих потребителей.
// ============================================================

import { notFound } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileDto } from '@superapp/shared';
import { useRequireAuth } from '../../../lib/hooks/useRequireAuth';
import { useFileUpload } from '../../../lib/hooks/useFileUpload';
import { filesUsageKey } from '../../../lib/queries';
import { deleteFile, getFilesUsage } from '../../../lib/files-api';
import { FileDropzone } from '../../../components/files/FileDropzone';
import { UploadProgressList } from '../../../components/files/UploadProgressList';
import { FileCard } from '../../../components/files/FileCard';
import { FileChip } from '../../../components/files/FileChip';
import { ImageLightbox } from '../../../components/files/ImageLightbox';
import { VideoPlayer } from '../../../components/files/VideoPlayer';
import { AudioPlayer } from '../../../components/files/AudioPlayer';
import { humanSize } from '../../../components/files/files-ui';

const PROFILES = ['generic', 'avatar', 'listing_image', 'chat_attachment', 'voice_message', 'document'];

export default function DevFilesPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <DevFilesInner />;
}

function DevFilesInner() {
  useRequireAuth();
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState('generic');
  const [files, setFiles] = useState<FileDto[]>([]);
  const [selected, setSelected] = useState<FileDto | null>(null);
  const [lightbox, setLightbox] = useState<FileDto | null>(null);

  const usageQuery = useQuery({ queryKey: filesUsageKey, queryFn: getFilesUsage });

  const uploader = useFileUpload(profile, {
    onUploaded: (file) => {
      setFiles((prev) => [file, ...prev]);
      void queryClient.invalidateQueries({ queryKey: filesUsageKey });
    },
  });

  const remove = async (file: FileDto) => {
    await deleteFile(file.id);
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    if (selected?.id === file.id) setSelected(null);
    void queryClient.invalidateQueries({ queryKey: filesUsageKey });
  };

  const usage = usageQuery.data;
  const usagePct = usage && usage.limitBytes > 0 ? Math.min(100, Math.round((usage.bytesUsed / usage.limitBytes) * 100)) : 0;

  return (
    <div style={{ maxWidth: '56rem', margin: '0 auto', padding: '2rem 1.25rem', fontFamily: 'var(--font-body)' }}>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 700 }}>
        🧪 Полигон движка файлов
      </h1>
      <p style={{ marginTop: '0.25rem', fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>
        Только development. Кирпичи веб-кита: дропзона (drag&drop + Ctrl+V), прогресс, карточки,
        просмотрщик, видео с постером и перемоткой, аудио, квота.
      </p>

      <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Профиль:</label>
        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          style={{
            padding: '0.35rem 0.6rem',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: 'var(--surface-container)',
            fontSize: '0.8rem',
          }}
        >
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {usage && (
          <div style={{ flex: 1, minWidth: '14rem' }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--on-surface-variant)' }}>
              Хранилище: {humanSize(usage.bytesUsed)} из {humanSize(usage.limitBytes)} · файлов: {usage.filesCount}
            </div>
            <div style={{ marginTop: 3, height: 6, background: 'var(--surface-container-high)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${usagePct}%`, background: usagePct > 90 ? 'var(--danger)' : 'var(--success)', borderRadius: 999 }} />
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: '1rem' }}>
        <FileDropzone onFiles={(fs) => uploader.add(fs)} paste multiple />
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <UploadProgressList items={uploader.items} onCancel={uploader.cancel} onRemove={uploader.remove} />
      </div>

      {files.length > 0 && (
        <>
          <h2 style={{ marginTop: '1.5rem', fontFamily: 'var(--font-display)', fontSize: '1.05rem', fontWeight: 700 }}>
            Загруженные
          </h2>
          <div style={{ marginTop: '0.6rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            {files.map((f) => (
              <FileCard
                key={f.id}
                file={f}
                onOpen={() => {
                  if (f.kind === 'image') setLightbox(f);
                  else setSelected(f);
                }}
                actions={
                  <button
                    type="button"
                    onClick={() => void remove(f)}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--danger)' }}
                  >
                    Удалить
                  </button>
                }
              />
            ))}
          </div>
        </>
      )}

      {selected && (
        <div style={{ marginTop: '1.25rem', padding: '0.9rem', background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-sketch)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <FileChip file={selected} />
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--on-surface-variant)' }}
            >
              ✕
            </button>
          </div>
          <div style={{ marginTop: '0.75rem' }}>
            {selected.kind === 'video' && <VideoPlayer file={selected} />}
            {selected.kind === 'audio' && <AudioPlayer file={selected} />}
            {selected.kind !== 'video' && selected.kind !== 'audio' && (
              <div style={{ fontSize: '0.78rem', color: 'var(--on-surface-variant)' }}>
                Предпросмотра для этого типа нет — используй «⬇️» в чипе, чтобы скачать.
              </div>
            )}
          </div>
        </div>
      )}

      {lightbox && <ImageLightbox file={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
