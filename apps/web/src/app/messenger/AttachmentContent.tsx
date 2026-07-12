'use client';

import { useState } from 'react';
import type { AttachmentFileRef, AttachmentsPayload, FileDto } from '@superapp/shared';
import { useFileDisplayUrl, useFileMeta } from '@/lib/hooks/useFileUrl';
import { FileChip } from '@/components/files/FileChip';
import { ImageLightbox } from '@/components/files/ImageLightbox';
import { VideoPlayer } from '@/components/files/VideoPlayer';
import { AudioPlayer } from '@/components/files/AudioPlayer';
import { TranscriptBlock, VoiceMessageBubble } from './VoiceMessageBubble';

// ============================================================
// Ф9: тело attachment-сообщения — фото/видео альбом-сеткой (Telegram),
// аудио — плеером, документы/прочее — чипами. Подпись рендерит бабл
// (она в message.content — К-1). Метаданные файла (варианты/размеры)
// дotягиваются useFileMeta — в payload только лёгкий снимок.
// ============================================================

export function AttachmentContent({ payload }: { payload: AttachmentsPayload }) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const media = files.filter((f) => f.kind === 'image' || f.kind === 'video');
  const audio = files.filter((f) => f.kind === 'audio');
  const rest = files.filter((f) => !['image', 'video', 'audio'].includes(f.kind));
  const [lightbox, setLightbox] = useState<FileDto | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      {media.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: media.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: '0.35rem',
            maxWidth: media.length === 1 ? '20rem' : '22rem',
          }}
        >
          {media.map((f) => (
            <MediaTile key={f.fileId} fileRef={f} single={media.length === 1} onOpenImage={setLightbox} />
          ))}
        </div>
      )}
      {audio.map((f) => (
        <AudioTile key={f.fileId} fileRef={f} />
      ))}
      {rest.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', alignItems: 'flex-start' }}>
          {rest.map((f) => (
            <DocChip key={f.fileId} fileRef={f} />
          ))}
        </div>
      )}
      {lightbox && <ImageLightbox file={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/** Фото/видео плитка: thumb приватного файла через подписанную ссылку */
function MediaTile({
  fileRef,
  single,
  onOpenImage,
}: {
  fileRef: AttachmentFileRef;
  single: boolean;
  onOpenImage: (file: FileDto) => void;
}) {
  const { meta } = useFileMeta(fileRef.fileId);
  // Видео: только постер-вариант, без фолбэка на оригинал — иначе <img> тянет весь ролик
  const { url } = useFileDisplayUrl(
    meta,
    fileRef.kind === 'video' ? 'poster' : 'thumb',
    fileRef.kind === 'video' ? { fallbackToOriginal: false } : undefined,
  );
  const [playing, setPlaying] = useState(false);

  if (fileRef.kind === 'video' && playing && meta) {
    return <VideoPlayer file={meta} maxWidth={single ? '20rem' : '100%'} />;
  }

  return (
    <div
      onClick={() => {
        if (!meta) return;
        if (fileRef.kind === 'image') onOpenImage(meta);
        else setPlaying(true);
      }}
      title={fileRef.name}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: single ? undefined : '1 / 1',
        minHeight: single ? '8rem' : undefined,
        maxHeight: single ? '16rem' : undefined,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--surface-container-high)',
        cursor: meta ? 'pointer' : 'wait',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={fileRef.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span style={{ fontSize: '1.4rem', opacity: 0.5 }}>{fileRef.kind === 'video' ? '🎬' : '🖼️'}</span>
      )}
      {fileRef.kind === 'video' && (
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
    </div>
  );
}

function AudioTile({ fileRef }: { fileRef: AttachmentFileRef }) {
  const { meta } = useFileMeta(fileRef.fileId);
  if (!meta) {
    return (
      <div style={{ fontSize: '0.78rem', color: 'var(--on-surface-variant)' }}>
        {fileRef.profile === 'voice_message' ? '🎤' : '🎵'} {fileRef.name}…
      </div>
    );
  }
  // Голосовое с волной → голосовой бабл; иначе (музыка/старые файлы/dev без ffmpeg) — плеер.
  // «Расшифровать» доступна ЛЮБОМУ аудио-вложению (движку всё равно, откуда файл)
  const waveform = (meta.meta as { waveform?: unknown } | null)?.waveform;
  if (meta.profile === 'voice_message' && Array.isArray(waveform) && waveform.length > 0) {
    return <VoiceMessageBubble file={meta} />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <AudioPlayer file={meta} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', paddingLeft: '0.4rem' }}>
        <TranscriptBlock fileId={meta.id} />
      </div>
    </div>
  );
}

/** Документ/прочее: чип со скачиванием (данные из снимка payload — без meta-запроса) */
function DocChip({ fileRef }: { fileRef: AttachmentFileRef }) {
  return (
    <FileChip
      file={{
        id: fileRef.fileId,
        name: fileRef.name,
        size: fileRef.size,
        kind: fileRef.kind,
        mime: fileRef.mime ?? 'application/octet-stream',
        status: 'ready',
      }}
    />
  );
}
