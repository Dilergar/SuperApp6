'use client';

import { useMemo, useState } from 'react';
import type { VoiceSegment } from '@superapp/shared';
import { formatDuration } from '@/components/files/files-ui';

// ============================================================
// Транскрипт записи: сегменты сгруппированы по подряд идущему
// спикеру (чипы «Спикер 1/2…»), метки [m:ss] с клик-seek,
// «Скопировать текст». Без speaker-полей — простые абзацы.
// ============================================================

interface SpeakerGroup {
  speaker: string | null;
  startSec: number;
  parts: VoiceSegment[];
}

const SPEAKER_COLORS = [
  'var(--secondary)',
  'var(--primary)',
  '#7a6a2f',
  '#4a7a4f',
  '#7a4a6f',
  '#4f5a7a',
];

function speakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

/** Метка [m:ss] (часовые — [h:mm:ss]) — общий форматтер файлов, не своя копия */
function fmtStamp(sec: number): string {
  return formatDuration(Math.floor(sec) * 1000) ?? '0:00';
}

export function TranscriptView({
  segments,
  text,
  onSeek,
}: {
  segments: VoiceSegment[] | null;
  text: string | null;
  onSeek?: (sec: number) => void;
}) {
  const [copied, setCopied] = useState(false);

  const groups = useMemo<SpeakerGroup[]>(() => {
    if (!segments?.length) return [];
    const out: SpeakerGroup[] = [];
    for (const seg of segments) {
      const speaker = seg.speaker ?? null;
      const last = out[out.length - 1];
      if (last && last.speaker === speaker) last.parts.push(seg);
      else out.push({ speaker, startSec: seg.start, parts: [seg] });
    }
    return out;
  }, [segments]);

  const speakerIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of groups) {
      if (g.speaker && !map.has(g.speaker)) map.set(g.speaker, map.size);
    }
    return map;
  }, [groups]);

  const plainText = useMemo(() => {
    if (groups.length) {
      return groups
        .map((g) => {
          const label = g.speaker ? `Спикер ${(speakerIndex.get(g.speaker) ?? 0) + 1}: ` : '';
          return `${label}${g.parts.map((p) => p.text).join(' ')}`;
        })
        .join('\n\n');
    }
    return text ?? '';
  }, [groups, speakerIndex, text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard может быть недоступен — молча
    }
  };

  if (!groups.length && !text) return null;

  return (
    <div
      style={{
        background: 'var(--surface-container-low)',
        borderRadius: 'var(--radius-sketch, var(--radius-md))',
        padding: 'var(--spacing-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--spacing-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="title-sm" style={{ fontSize: '0.9rem' }}>Расшифровка</span>
        <button
          onClick={() => void copy()}
          className="btn-secondary"
          style={{ padding: '0.3rem 0.8rem', fontSize: '0.75rem' }}
        >
          {copied ? 'Скопировано ✓' : 'Скопировать текст'}
        </button>
      </div>

      {groups.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          {groups.map((g, i) => {
            const idx = g.speaker ? speakerIndex.get(g.speaker) ?? 0 : null;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {idx != null && (
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: 'var(--surface)',
                        background: speakerColor(idx),
                        borderRadius: '999px',
                        padding: '0.1rem 0.55rem',
                      }}
                    >
                      Спикер {idx + 1}
                    </span>
                  )}
                  <button
                    onClick={() => onSeek?.(g.startSec)}
                    title="Перемотать сюда"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: onSeek ? 'pointer' : 'default',
                      padding: 0,
                      fontSize: '0.7rem',
                      color: 'var(--on-surface-variant)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    [{fmtStamp(g.startSec)}]
                  </button>
                </div>
                <p style={{ fontSize: '0.88rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {g.parts.map((p) => p.text).join(' ')}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <p style={{ fontSize: '0.88rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {text}
        </p>
      )}
    </div>
  );
}
