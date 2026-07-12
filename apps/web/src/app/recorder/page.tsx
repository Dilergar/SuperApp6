'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { isAxiosError } from 'axios';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { VoiceLanguage, VoiceRecordingDto, VoiceTranscriptDto } from '@superapp/shared';
import { VOICE_LANGUAGES, VOICE_LANGUAGE_LABELS, VOICE_LIMITS } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { formatElapsed, useVoiceRecorder } from '@/lib/hooks/useVoiceRecorder';
import { useFileDisplayUrl } from '@/lib/hooks/useFileUrl';
import { uploadFile } from '@/lib/files-api';
import { FileDropzone } from '@/components/files/FileDropzone';
import { formatDuration } from '@/components/files/files-ui';
import {
  createRecording,
  deleteRecording,
  getTranscript,
  getVoiceStatus,
  listRecordings,
  renameRecording,
  requestTranscript,
} from '@/lib/voice-api';
import { recorderRecordingsKey, voiceStatusKey, voiceTranscriptKey } from '@/lib/queries';
import { TranscriptView } from './TranscriptView';

// ============================================================
// «Диктофон» — прото-Plaud без железки: записал/загрузил собрание →
// транскрипт со спикерами. Слева список записей, справа деталь
// (плеер + язык + «Расшифровать» + TranscriptView с клик-seek).
// Будущий дом протоколов собраний и записей SuperTerminal6.
// ============================================================

/** Человекочитаемая ошибка API (конверт AllExceptionsFilter), а не axios-заглушка */
function apiErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const msg = (err.response?.data as { message?: string } | undefined)?.message;
    if (msg) return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * ОС/браузер не всегда отдают корректный MIME (пустой, octet-stream) —
 * доводим по расширению, иначе профиль-whitelist движка отфутболит файл.
 * Сниф magic-bytes на сервере всё равно перепроверит содержимое.
 */
const AUDIO_EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
};

function normalizeAudioMime(file: File): File {
  // .webm ОС регистрирует как ВИДЕО-тип — наша же запись голоса при повторной
  // загрузке приходит как video/webm; для Диктофона это аудио
  if (file.type === 'video/webm') return new File([file], file.name, { type: 'audio/webm' });
  if (file.type && file.type !== 'application/octet-stream') return file;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = AUDIO_EXT_MIME[ext];
  return mime ? new File([file], file.name, { type: mime }) : file;
}

export default function RecorderPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
        </div>
      }
    >
      <RecorderInner />
    </Suspense>
  );
}

function RecorderInner() {
  const { isReady } = useRequireAuth();
  const searchParams = useSearchParams();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('id'));
  const [uploadingLabel, setUploadingLabel] = useState<string | null>(null);

  const { data: recordings = [], isLoading } = useQuery({
    queryKey: recorderRecordingsKey,
    queryFn: listRecordings,
    enabled: isReady,
  });
  const { data: voiceStatus } = useQuery({
    queryKey: voiceStatusKey,
    queryFn: getVoiceStatus,
    enabled: isReady,
    staleTime: 5 * 60 * 1000,
  });

  // Выбор: ?id= из уведомления → первая запись
  useEffect(() => {
    if (selectedId && recordings.some((r) => r.id === selectedId)) return;
    if (recordings.length) setSelectedId(recordings[0].id);
    else setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordings]);

  const selected = recordings.find((r) => r.id === selectedId) ?? null;

  const afterNewRecording = async (rec: VoiceRecordingDto) => {
    await qc.invalidateQueries({ queryKey: recorderRecordingsKey });
    setSelectedId(rec.id);
  };

  // Загрузка файла записи (m4a/mp3/wav/ogg/flac) → сразу создаём запись
  // (закрывает окно orphan-реапа несвязанного файла)
  const handleFiles = async (files: File[]) => {
    for (const raw of files) {
      const f = normalizeAudioMime(raw);
      setUploadingLabel(`Загрузка «${f.name}»…`);
      try {
        const dto = await uploadFile(f, 'dictaphone', {
          onProgress: (fr) => setUploadingLabel(`Загрузка «${f.name}»… ${Math.round(fr * 100)}%`),
        });
        const rec = await createRecording({ fileId: dto.id, source: 'upload' });
        await afterNewRecording(rec);
      } catch (err) {
        alert(`Не удалось загрузить: ${apiErrorMessage(err)}`);
      } finally {
        setUploadingLabel(null);
      }
    }
  };

  // Запись в браузере
  const recorder = useVoiceRecorder();
  const finishBrowserRecording = async () => {
    const file = await recorder.stop();
    if (!file) return;
    setUploadingLabel('Сохранение записи…');
    try {
      const dto = await uploadFile(file, 'dictaphone', {
        onProgress: (fr) => setUploadingLabel(`Сохранение записи… ${Math.round(fr * 100)}%`),
      });
      const rec = await createRecording({ fileId: dto.id, source: 'web' });
      await afterNewRecording(rec);
    } catch (err) {
      alert(`Не удалось сохранить запись: ${apiErrorMessage(err)}`);
    } finally {
      setUploadingLabel(null);
    }
  };
  useEffect(() => {
    if (recorder.state === 'recording' && recorder.elapsedMs >= VOICE_LIMITS.recorderMaxBrowserRecordSec * 1000) {
      void finishBrowserRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.state, recorder.elapsedMs]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <nav
        className="fixed top-0 w-full z-50 px-6 py-4"
        style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}
      >
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>
            SuperApp6
          </Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Link href="/messenger" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Мессенджер
            </Link>
            <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Главная
            </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-12)' }}>
        {/* Шапка сервиса */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-6)' }}>
          <div>
            <h1 className="title-lg" style={{ transform: 'rotate(-0.5deg)' }}>🎙️ Диктофон</h1>
            <p className="label-sm" style={{ opacity: 0.75, marginTop: '0.3rem' }}>
              Запиши собрание или загрузи файл — получишь текст с разбивкой по спикерам
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center' }}>
            {recorder.state === 'recording' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  background: 'var(--surface-container-high)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.45rem 0.8rem',
                }}
              >
                <span
                  aria-hidden
                  style={{ width: '0.6rem', height: '0.6rem', borderRadius: '50%', background: 'var(--primary)', animation: 'sa6RecPulse 1.1s ease-in-out infinite' }}
                />
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{formatElapsed(recorder.elapsedMs)}</span>
                <button onClick={recorder.cancel} className="btn-secondary" style={{ padding: '0.3rem 0.7rem', fontSize: '0.75rem' }}>
                  Отмена
                </button>
                <button onClick={() => void finishBrowserRecording()} className="btn-primary" style={{ padding: '0.3rem 0.9rem', fontSize: '0.75rem' }}>
                  ⏹ Готово
                </button>
                <style>{`@keyframes sa6RecPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
              </div>
            ) : (
              recorder.state !== 'unsupported' && (
                <button
                  onClick={() => void recorder.start()}
                  className="btn-primary"
                  style={{ padding: '0.5rem 1.1rem', fontSize: '0.85rem' }}
                  title={recorder.state === 'denied' ? 'Доступ к микрофону запрещён в браузере' : 'Записать с микрофона'}
                >
                  ⏺ Записать
                </button>
              )
            )}
          </div>
        </div>

        {uploadingLabel && (
          <div
            style={{
              marginBottom: 'var(--spacing-4)',
              padding: '0.6rem 1rem',
              background: 'var(--secondary-container)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.85rem',
            }}
          >
            {uploadingLabel}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(16rem, 22rem) 1fr', gap: 'var(--spacing-6)', alignItems: 'start' }}>
          {/* Левая колонка: загрузка + список */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
            <FileDropzone
              onFiles={(files) => void handleFiles(files)}
              // расширения явно: .webm ОС считает видео и прячет за audio/*
              accept="audio/*,.webm,.mp3,.m4a,.wav,.ogg,.oga,.opus,.flac,.aac"
              multiple={false}
              compact
              label="Загрузить запись"
              hint="mp3 / m4a / wav / ogg / webm / flac · до 200 МБ"
              disabled={!!uploadingLabel}
            />
            {isLoading ? (
              <p className="label-sm" style={{ opacity: 0.7 }}>Загрузка…</p>
            ) : recordings.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--spacing-8) var(--spacing-4)', background: 'var(--surface-container-low)', borderRadius: 'var(--radius-sketch, var(--radius-md))' }}>
                <div style={{ fontSize: '2rem' }}>🎙️</div>
                <p className="label-sm" style={{ opacity: 0.7, marginTop: '0.4rem' }}>
                  Пока пусто. Запиши собрание или загрузи аудио-файл
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                {recordings.map((r, i) => (
                  <RecordingRow
                    key={r.id}
                    rec={r}
                    active={r.id === selectedId}
                    tilt={i % 2 === 0 ? -0.3 : 0.3}
                    onSelect={() => setSelectedId(r.id)}
                    onDeleted={() => {
                      if (selectedId === r.id) setSelectedId(null);
                      void qc.invalidateQueries({ queryKey: recorderRecordingsKey });
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Правая колонка: деталь */}
          <div>
            {selected ? (
              <RecordingDetail rec={selected} sttEnabled={!!voiceStatus?.enabled} />
            ) : (
              <div style={{ textAlign: 'center', padding: 'var(--spacing-10)', background: 'var(--surface-container-low)', borderRadius: 'var(--radius-sketch, var(--radius-md))' }}>
                <p className="label-sm" style={{ opacity: 0.7 }}>Выбери запись слева</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- строка списка ----------

function RecordingRow({
  rec,
  active,
  tilt,
  onSelect,
  onDeleted,
}: {
  rec: VoiceRecordingDto;
  active: boolean;
  tilt: number;
  onSelect: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(rec.title);

  const saveTitle = async () => {
    setEditing(false);
    const next = title.trim();
    if (!next || next === rec.title) {
      setTitle(rec.title);
      return;
    }
    try {
      await renameRecording(rec.id, next);
      await qc.invalidateQueries({ queryKey: recorderRecordingsKey });
    } catch {
      setTitle(rec.title);
    }
  };

  const remove = async () => {
    if (!confirm(`Удалить запись «${rec.title}» вместе с расшифровкой?`)) return;
    try {
      await deleteRecording(rec.id);
      onDeleted();
    } catch (err) {
      alert(`Не удалось удалить: ${err instanceof Error ? err.message : err}`);
    }
  };

  const statusBadge =
    rec.transcriptStatus === 'ready'
      ? { text: 'Расшифровано', color: 'var(--secondary)' }
      : rec.transcriptStatus === 'queued' || rec.transcriptStatus === 'processing'
        ? { text: 'Расшифровываю…', color: 'var(--on-surface-variant)' }
        : rec.transcriptStatus === 'error'
          ? { text: 'Ошибка', color: 'var(--primary)' }
          : null;

  return (
    <div
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        padding: '0.7rem 0.9rem',
        background: active ? 'var(--secondary-container)' : 'var(--surface-container)',
        borderRadius: 'var(--radius-sketch, var(--radius-md))',
        transform: `rotate(${tilt}deg)`,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveTitle();
              if (e.key === 'Escape') {
                setTitle(rec.title);
                setEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: '0.85rem',
              fontWeight: 700,
              background: 'var(--surface)',
              border: 'none',
              borderRadius: 'var(--radius-sm, 6px)',
              padding: '0.15rem 0.4rem',
            }}
          />
        ) : (
          <span style={{ flex: 1, minWidth: 0, fontSize: '0.85rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rec.title}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          title="Переименовать"
          aria-label="Переименовать"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', opacity: 0.55, padding: 0 }}
        >
          ✏️
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void remove();
          }}
          title="Удалить"
          aria-label="Удалить"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', opacity: 0.55, padding: 0 }}
        >
          🗑️
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.7rem', color: 'var(--on-surface-variant)' }}>
        <span>{new Date(rec.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
        {rec.durationMs != null && <span>{formatDuration(rec.durationMs)}</span>}
        <span>{rec.source === 'web' ? '⏺ браузер' : rec.source === 'terminal' ? '📟 терминал' : '📄 файл'}</span>
        {statusBadge && <span style={{ color: statusBadge.color, fontWeight: 700 }}>{statusBadge.text}</span>}
      </div>
    </div>
  );
}

// ---------- деталь записи ----------

function RecordingDetail({ rec, sttEnabled }: { rec: VoiceRecordingDto; sttEnabled: boolean }) {
  const qc = useQueryClient();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [language, setLanguage] = useState<VoiceLanguage>(rec.language ?? 'auto');
  const [requestError, setRequestError] = useState<string | null>(null);
  const fileId = rec.file?.id ?? null;
  const { url } = useFileDisplayUrl(rec.file);

  const { data: transcript } = useQuery<VoiceTranscriptDto | null>({
    queryKey: voiceTranscriptKey(fileId ?? 'none'),
    queryFn: () => getTranscript(fileId as string),
    enabled: !!fileId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'queued' || s === 'processing' ? VOICE_LIMITS.pollIntervalMs : false;
    },
    refetchOnWindowFocus: false,
  });

  // Готовность/ошибка транскрипта меняет бейдж в списке
  useEffect(() => {
    if (transcript?.status === 'ready' || transcript?.status === 'error') {
      void qc.invalidateQueries({ queryKey: recorderRecordingsKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript?.status]);

  const ask = async () => {
    if (!fileId) return;
    setRequestError(null);
    try {
      const dto = await requestTranscript(fileId, { language, diarize: true });
      qc.setQueryData(voiceTranscriptKey(fileId), dto);
      // Инвалидация обязательна: setQueryData НЕ перевзводит refetchInterval
      // устоявшегося запроса — без рефетча поллинг не стартует
      void qc.invalidateQueries({ queryKey: voiceTranscriptKey(fileId) });
      void qc.invalidateQueries({ queryKey: recorderRecordingsKey });
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'Не удалось запросить расшифровку');
    }
  };

  const seekTo = (sec: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = sec;
    void el.play().catch(() => undefined);
  };

  const inProgress = transcript?.status === 'queued' || transcript?.status === 'processing';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      <div
        style={{
          background: 'var(--surface-container)',
          borderRadius: 'var(--radius-sketch, var(--radius-md))',
          padding: 'var(--spacing-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap' }}>
          <h2 className="title-sm" style={{ fontSize: '1.05rem' }}>{rec.title}</h2>
          <span style={{ fontSize: '0.72rem', color: 'var(--on-surface-variant)' }}>
            {new Date(rec.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {url ? (
          <audio ref={audioRef} controls preload="metadata" src={url} style={{ width: '100%', height: '2.2rem' }} />
        ) : (
          <p className="label-sm" style={{ opacity: 0.7 }}>{rec.file ? 'Загружаю аудио…' : 'Файл записи недоступен'}</p>
        )}

        {/* Расшифровка: язык + запуск */}
        {fileId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            {!sttEnabled ? (
              <span className="label-sm" style={{ opacity: 0.7 }}>
                Расшифровка не подключена (запусти whisper-контейнер и задай VOICE_STT_URL)
              </span>
            ) : inProgress ? (
              <span className="label-sm" style={{ fontWeight: 700 }}>⏳ Расшифровываю… это может занять несколько минут</span>
            ) : transcript?.status === 'ready' ? (
              <span className="label-sm" style={{ color: 'var(--secondary)', fontWeight: 700 }}>
                ✓ Расшифровано{transcript.detectedLanguage ? ` · язык: ${transcript.detectedLanguage}` : ''}
              </span>
            ) : (
              <>
                <label className="label-sm" htmlFor="rec-lang" style={{ opacity: 0.8 }}>Язык:</label>
                <select
                  id="rec-lang"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as VoiceLanguage)}
                  style={{
                    background: 'var(--surface-container-high)',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    padding: '0.35rem 0.6rem',
                    fontSize: '0.8rem',
                  }}
                >
                  {VOICE_LANGUAGES.map((l) => (
                    <option key={l} value={l}>{VOICE_LANGUAGE_LABELS[l]}</option>
                  ))}
                </select>
                <button onClick={() => void ask()} className="btn-primary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
                  {transcript?.status === 'error' ? 'Расшифровать ещё раз' : 'Расшифровать'}
                </button>
                {transcript?.status === 'error' && (
                  <span className="label-sm" style={{ color: 'var(--primary)' }} title={transcript.error ?? undefined}>
                    Прошлая попытка не удалась
                  </span>
                )}
              </>
            )}
            {requestError && <span className="label-sm" style={{ color: 'var(--primary)' }}>{requestError}</span>}
          </div>
        )}
      </div>

      {transcript?.status === 'ready' && (
        <TranscriptView segments={transcript.segments} text={transcript.text} onSeek={seekTo} />
      )}
    </div>
  );
}
