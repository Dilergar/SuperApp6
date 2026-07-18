'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FileDto, VoiceStatusDto } from '@superapp/shared';
import { useFileDisplayUrl } from '@/lib/hooks/useFileUrl';
import { useVoiceTranscript } from '@/lib/hooks/useVoiceTranscript';
import { formatDuration } from '@/components/files/files-ui';
import { getVoiceStatus } from '@/lib/voice-api';
import { voiceStatusKey } from '@/lib/queries';

// ============================================================
// Голосовой бабл (Telegram-модель): волна из meta.waveform (клик-seek),
// play/pause, скорость, «Расшифровать» → поллинг транскрипта → текст.
// Рендерится из AudioTile, когда файл — voice_message с волной.
// ============================================================

const SPEEDS = [1, 1.5, 2] as const;

export function VoiceMessageBubble({
  file,
  directUrl,
}: {
  // Структурный сабсет FileDto: бабл умеет рисоваться и из серверного view-обогащения
  // payload (синтетический объект без полного FileDto); настоящий FileDto подходит как раньше
  file: Pick<FileDto, 'id' | 'publicUrl' | 'variants' | 'meta'>;
  /** Готовая ссылка из view attachment-payload — не дергаем GET /files/:id/download */
  directUrl?: string | null;
}) {
  // Битая/протухшая direct-ссылка (onError у <audio>) → фолбэк на подписанную через хук
  const [directBroken, setDirectBroken] = useState(false);
  const useDirect = !!directUrl && !directBroken;
  const { url: hookUrl } = useFileDisplayUrl(file, undefined, { enabled: !useDirect });
  const url = useDirect ? directUrl : hookUrl;
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

  const hasMetaDuration = typeof meta.durationMs === 'number' && meta.durationMs > 0;
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    let fixingInfinity = false;
    const onTime = () => {
      if (fixingInfinity) return; // сик-трюк гоняет currentTime — не отражаем в UI
      setPositionSec(el.currentTime);
    };
    const onEnd = () => {
      setPlaying(false);
      setPositionSec(0);
    };
    // Chrome у webm из MediaRecorder отдаёт duration=Infinity. Конвейер обычно кладёт
    // meta.durationMs (теперь и для webm — из PCM), но старые файлы / dev без ffmpeg
    // лечим сик-трюком: прыжок «в бесконечность» заставляет браузер досчитать
    // реальную длительность (придёт durationchange с конечным значением)
    const onMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setFallbackDurationSec(el.duration);
        if (fixingInfinity) {
          fixingInfinity = false;
          el.currentTime = 0;
          setPositionSec(0);
        }
        return;
      }
      if (el.duration === Infinity && !hasMetaDuration && !fixingInfinity) {
        fixingInfinity = true;
        try {
          el.currentTime = 1e7;
        } catch {
          fixingInfinity = false;
        }
      }
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
  }, [url, hasMetaDuration]);

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
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onError={useDirect ? () => setDirectBroken(true) : undefined}
          style={{ display: 'none' }}
        />
      )}
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
 * Три состояния: не просили → кнопка; в работе → «Расшифровываю…»;
 * ошибка (запроса или джоба) → «Повторить»; готово → текст.
 */
export function TranscriptBlock({ fileId }: { fileId: string }) {
  const [requested, setRequested] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const { data: status } = useQuery<VoiceStatusDto>({
    queryKey: voiceStatusKey,
    queryFn: getVoiceStatus,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  // enabled по клику — не бомбим API гарантированными 404 на каждый бабл;
  // кэш общего ключа (расшифровали в Диктофоне) показывается и без клика
  const { transcript, requestError, ask } = useVoiceTranscript(fileId, { enabled: requested });

  if (!status?.enabled) return null;

  const request = () => {
    setRequested(true);
    void ask();
  };

  if (requestError || transcript?.status === 'error') {
    return (
      <button onClick={request} style={linkBtnStyle} title={transcript?.error ?? requestError ?? undefined}>
        Не удалось · Повторить
      </button>
    );
  }
  if (!requested && !transcript) {
    return (
      <button onClick={request} style={linkBtnStyle} title="Расшифровать голосовое в текст">
        Расшифровать
      </button>
    );
  }
  if (!transcript || transcript.status === 'queued' || transcript.status === 'processing') {
    return <span style={{ fontSize: '0.68rem', color: 'var(--on-surface-variant)' }}>Расшифровываю…</span>;
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
