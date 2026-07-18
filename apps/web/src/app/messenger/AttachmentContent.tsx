'use client';

import { useEffect, useState } from 'react';
import type { AttachmentFileRef, AttachmentFileView, AttachmentsPayload, FileDto } from '@superapp/shared';
import { isVoiceNoteProfile } from '@superapp/shared';
import { useFileDisplayUrl, useFileMeta } from '@/lib/hooks/useFileUrl';
import { FileChip } from '@/components/files/FileChip';
import { ImageLightbox } from '@/components/files/ImageLightbox';
import { VideoPlayer } from '@/components/files/VideoPlayer';
import { AudioPlayer } from '@/components/files/AudioPlayer';
import { TranscriptBlock, VoiceMessageBubble } from './VoiceMessageBubble';

// ============================================================
// Ф9: тело attachment-сообщения — фото/видео альбом-сеткой (Telegram),
// аудио — плеером, документы/прочее — чипами. Подпись рендерит бабл
// (она в message.content — К-1). Быстрый путь: сервер обогащает payload
// готовыми ссылками+метой (`file.view`, модель Slack/Discord) — живой view
// рисуется ВООБЩЕ без сети; протухший/отсутствующий/битый (onError) view
// падает на старый путь useFileMeta+useFileDisplayUrl.
// ============================================================

/**
 * Ссылка из серверного view ещё жива (запас 30с — чтобы не отрисовать
 * почти-протухшую подпись, которая умрёт до клика). null = вечная публичная.
 */
function isViewFresh(view: AttachmentFileView | undefined): view is AttachmentFileView {
  if (!view) return false;
  if (view.urlExpiresAt == null) return true;
  return new Date(view.urlExpiresAt).getTime() > Date.now() + 30_000;
}

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

/** Фото/видео плитка: живой view из payload — ссылка сразу, без сети; иначе thumb через хуки */
function MediaTile({
  fileRef,
  single,
  onOpenImage,
}: {
  fileRef: AttachmentFileRef;
  single: boolean;
  onOpenImage: (file: FileDto) => void;
}) {
  // Битая view-ссылка (onError) → фолбэк на старый путь хуков
  const [viewBroken, setViewBroken] = useState(false);
  const view = !viewBroken && isViewFresh(fileRef.view) ? fileRef.view : undefined;
  // С живым view мета нужна только ПОСЛЕ клика (лайтбокс/плеер хотят FileDto) —
  // тянем её лениво, а не на каждую плитку ленты
  const [wantMeta, setWantMeta] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const { meta } = useFileMeta(fileRef.fileId, { enabled: !view || wantMeta });
  // Видео: только постер-вариант, без фолбэка на оригинал — иначе <img> тянет весь ролик
  const { url: hookUrl } = useFileDisplayUrl(
    meta,
    fileRef.kind === 'video' ? 'poster' : 'thumb',
    { fallbackToOriginal: fileRef.kind !== 'video', enabled: !view },
  );
  // То же правило для view: видео — только posterUrl, фото — thumb или оригинал
  const viewUrl = view
    ? fileRef.kind === 'video'
      ? view.posterUrl
      : view.thumbUrl ?? view.url
    : null;
  const url = view ? viewUrl : hookUrl;
  const [playing, setPlaying] = useState(false);

  // Клик по view-плитке пришёл раньше меты — открываем, как только она доедет
  useEffect(() => {
    if (!pendingOpen || !meta) return;
    setPendingOpen(false);
    if (fileRef.kind === 'image') onOpenImage(meta);
    else setPlaying(true);
  }, [pendingOpen, meta, fileRef.kind, onOpenImage]);

  if (fileRef.kind === 'video' && playing && meta) {
    return <VideoPlayer file={meta} maxWidth={single ? '20rem' : '100%'} />;
  }

  return (
    <div
      onClick={() => {
        if (meta) {
          if (fileRef.kind === 'image') onOpenImage(meta);
          else setPlaying(true);
          return;
        }
        if (view) {
          // Мета ещё не тянулась (view закрыл рендер без сети) — дотягиваем по клику
          setWantMeta(true);
          setPendingOpen(true);
        }
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
        cursor: meta || view ? 'pointer' : 'wait',
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
          onError={view ? () => setViewBroken(true) : undefined}
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
  const view = isViewFresh(fileRef.view) ? fileRef.view : undefined;
  // Голосовое с готовым view (ссылка + волна + длительность прямо в payload) —
  // рисуем бабл без единого запроса; битая ссылка → бабл сам падает на хук
  const viewVoice =
    !!view &&
    isVoiceNoteProfile(fileRef.profile) &&
    Array.isArray(view.waveform) &&
    view.waveform.length > 0;
  const { meta } = useFileMeta(fileRef.fileId, { enabled: !viewVoice });
  if (viewVoice && view) {
    return (
      <VoiceMessageBubble
        file={{
          id: fileRef.fileId,
          publicUrl: null,
          variants: [],
          meta: { durationMs: view.durationMs ?? undefined, waveform: view.waveform ?? undefined },
        }}
        directUrl={view.url}
      />
    );
  }
  if (!meta) {
    return (
      <div style={{ fontSize: '0.78rem', color: 'var(--on-surface-variant)' }}>
        {isVoiceNoteProfile(fileRef.profile) ? '🎤' : '🎵'} {fileRef.name}…
      </div>
    );
  }
  // Голосовое с волной → голосовой бабл; иначе (музыка/старые файлы/dev без ffmpeg) — плеер.
  // «Расшифровать» доступна ЛЮБОМУ аудио-вложению (движку всё равно, откуда файл)
  const waveform = (meta.meta as { waveform?: unknown } | null)?.waveform;
  if (isVoiceNoteProfile(meta.profile) && Array.isArray(waveform) && waveform.length > 0) {
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
