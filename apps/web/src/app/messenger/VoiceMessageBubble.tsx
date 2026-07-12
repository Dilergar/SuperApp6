'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileDto, VoiceStatusDto, VoiceTranscriptDto } from '@superapp/shared';
import { VOICE_LIMITS } from '@superapp/shared';
import { useFileDisplayUrl } from '@/lib/hooks/useFileUrl';
import { formatDuration } from '@/components/files/files-ui';
import { getTranscript, getVoiceStatus, requestTranscript } from '@/lib/voice-api';
import { voiceStatusKey, voiceTranscriptKey } from '@/lib/queries';

// ============================================================
// Голосовой бабл (Telegram-модель): волна из meta.waveform (клик-seek),
// play/pause, скорость, «Расшифровать» → поллинг транскрипта → текст.
// Рендерится из AudioTile, когда файл — voice_message с волной.
// ============================================================

const SPEEDS = [1, 1.5, 2] as const;

export function VoiceMessageBubble({ file }: { file: FileDto }) {
  const { url } = useFileDisplayUrl(file);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [fallbackDurationSec, setFallbackDurationSec] = useState<number | null>(null);

  const meta = (file.meta as { durationMs?: number; waveform?: number[] } | null) ?? {};
  const waveform = Array.isArray(meta.waveform) ? meta.waveform : [];
  const durationSec =
    typeof meta.durationMs === 'number' && meta.durationMs > 0
      ? meta.durationMs / 1000
      : fallbackDurationSec;

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setPositionSec(el.currentTime);
    const onEnd = () => {
      setPlaying(false);
      setPositionSec(0);
    };
    // Chrome у webm из MediaRecorder отдаёт duration=Infinity — берём из loadedmetadata,
    // а Infinity лечится seek-трюком на большом времени
    const onMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) setFallbackDurationSec(el.duration);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
    };
  }, [url]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.playbackRate = SPEEDS[speedIdx];
      void el.play();
      setPlaying(true);
    }
  };

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  };

  const seekTo = (fraction: number) => {
    const el = audioRef.current;
    if (!el || durationSec == null || !Number.isFinite(durationSec)) return;
    el.currentTime = Math.max(0, Math.min(durationSec, fraction * durationSec));
    setPositionSec(el.currentTime);
  };

  const progress = durationSec && durationSec > 0 ? Math.min(1, positionSec / durationSec) : 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
        padding: '0.45rem 0.6rem',
        background: 'var(--surface-container)',
        borderRadius: 'var(--radius-sketch, var(--radius-md))',
        maxWidth: '22rem',
        minWidth: '15rem',
      }}
    >
      {url && <audio ref={audioRef} src={url} preload="metadata" style={{ display: 'none' }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <button
          onClick={toggle}
          disabled={!url}
          title={playing ? 'Пауза' : 'Слушать'}
          aria-label={playing ? 'Пауза' : 'Слушать'}
          style={{
            flexShrink: 0,
            width: '2.3rem',
            height: '2.3rem',
            borderRadius: '50%',
            border: 'none',
            cursor: url ? 'pointer' : 'wait',
            background: 'var(--primary)',
            color: 'var(--on-primary, #fff)',
            fontSize: '0.95rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <Waveform bars={waveform} progress={progress} onSeek={seekTo} />
        <button
          onClick={cycleSpeed}
          title="Скорость воспроизведения"
          aria-label="Скорость воспроизведения"
          style={{
            flexShrink: 0,
            border: 'none',
            cursor: 'pointer',
            background: 'var(--surface-container-high)',
            color: 'var(--on-surface-variant)',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.68rem',
            fontWeight: 700,
            padding: '0.25rem 0.4rem',
          }}
        >
          ×{SPEEDS[speedIdx]}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', paddingLeft: '2.9rem' }}>
        <span style={{ fontSize: '0.68rem', color: 'var(--on-surface-variant)', fontVariantNumeric: 'tabular-nums' }}>
          {playing || positionSec > 0 ? `${formatDuration(positionSec * 1000)} / ` : ''}
          {durationSec != null ? formatDuration(durationSec * 1000) : '…'}
        </span>
        <TranscriptBlock fileId={file.id} />
      </div>
    </div>
  );
}

function Waveform({
  bars,
  progress,
  onSeek,
}: {
  bars: number[];
  progress: number;
  onSeek: (fraction: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const playedCount = Math.round(progress * bars.length);
  return (
    <div
      ref={ref}
      onClick={(e) => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        onSeek((e.clientX - rect.left) / rect.width);
      }}
      role="slider"
      aria-label="Позиция воспроизведения"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        height: '1.8rem',
        cursor: 'pointer',
        minWidth: 0,
      }}
    >
      {bars.map((v, i) => (
        <span
          key={i}
          style={{
            flex: 1,
            minWidth: '1px',
            height: `${Math.max(12, v)}%`,
            borderRadius: '2px',
            background: i < playedCount ? 'var(--primary)' : 'var(--on-surface-variant)',
            opacity: i < playedCount ? 1 : 0.35,
          }}
        />
      ))}
    </div>
  );
}

/**
 * «Расшифровать» + поллинг + текст (кэш навсегда: 1 файл = 1 транскрипт).
 * Экспортируется: AudioTile вешает его и на ОБЫЧНЫЕ аудио-вложения чата
 * (скинутый файлом webm/mp3 расшифровывается так же, как голосовое).
 */
export function TranscriptBlock({ fileId }: { fileId: string }) {
  const qc = useQueryClient();
  const [requested, setRequested] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const { data: status } = useQuery<VoiceStatusDto>({
    queryKey: voiceStatusKey,
    queryFn: getVoiceStatus,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: transcript } = useQuery<VoiceTranscriptDto | null>({
    queryKey: voiceTranscriptKey(fileId),
    queryFn: () => getTranscript(fileId),
    enabled: requested,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'queued' || s === 'processing' ? VOICE_LIMITS.pollIntervalMs : false;
    },
    refetchOnWindowFocus: false,
  });

  if (!status?.enabled) return null;

  const ask = async () => {
    setRequestError(null);
    setRequested(true);
    try {
      const dto = await requestTranscript(fileId);
      qc.setQueryData(voiceTranscriptKey(fileId), dto);
      // setQueryData не перевзводит refetchInterval устоявшегося запроса — рефетчим явно
      void qc.invalidateQueries({ queryKey: voiceTranscriptKey(fileId) });
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'Не удалось запросить расшифровку');
    }
  };

  if (!requested || (!transcript && !requestError)) {
    return (
      <>
        <button onClick={() => void ask()} style={linkBtnStyle} title="Расшифровать голосовое в текст">
          {requested ? '…' : 'Расшифровать'}
        </button>
        {requestError && <span style={{ fontSize: '0.68rem', color: 'var(--primary)' }}>{requestError}</span>}
      </>
    );
  }

  if (requestError) {
    return (
      <button onClick={() => void ask()} style={linkBtnStyle}>
        Не удалось · Повторить
      </button>
    );
  }

  if (!transcript) return null;

  if (transcript.status === 'queued' || transcript.status === 'processing') {
    return <span style={{ fontSize: '0.68rem', color: 'var(--on-surface-variant)' }}>Расшифровываю…</span>;
  }
  if (transcript.status === 'error') {
    return (
      <button onClick={() => void ask()} style={linkBtnStyle} title={transcript.error ?? undefined}>
        Не удалось · Повторить
      </button>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', minWidth: 0, flex: 1 }}>
      <button onClick={() => setCollapsed(!collapsed)} style={{ ...linkBtnStyle, alignSelf: 'flex-start' }}>
        {collapsed ? 'Показать текст' : 'Скрыть текст'}
      </button>
      {!collapsed && (
        <div
          style={{
            fontSize: '0.78rem',
            fontStyle: 'italic',
            color: 'var(--on-surface)',
            opacity: 0.85,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {transcript.text || '(пусто)'}
        </div>
      )}
    </div>
  );
}

const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  fontSize: '0.68rem',
  fontWeight: 700,
  color: 'var(--secondary)',
};
