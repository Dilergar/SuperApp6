'use client';

import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { VOICE_LIMITS } from '@superapp/shared';
import { uploadFile } from '@/lib/files-api';
import { formatElapsed, useVoiceRecorder } from '@/lib/hooks/useVoiceRecorder';

// ============================================================
// Кнопка 🎤 в композере: клик → полоса записи (пульс, таймер,
// Отмена/Отправить) → upload профилем voice_message → onSent(fileId)
// (родитель шлёт существующим attachment-путём). Скрыта, если браузер
// не умеет MediaRecorder.
// ============================================================

export function VoiceRecordButton({ onSent }: { onSent: (fileId: string) => void }) {
  const { state, elapsedMs, start, stop, cancel } = useVoiceRecorder();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const sendingRef = useRef(false);

  const maxMs = VOICE_LIMITS.maxVoiceMessageSec * 1000;

  const finishAndSend = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      const file = await stop();
      if (!file) return;
      setUploading(true);
      setProgress(0);
      const dto = await uploadFile(file, 'voice_message', {
        onProgress: (f) => setProgress(Math.round(f * 100)),
      });
      onSent(dto.id);
    } catch (err) {
      const msg = isAxiosError(err)
        ? ((err.response?.data as { message?: string } | undefined)?.message ?? err.message)
        : err instanceof Error ? err.message : String(err);
      alert(`Не удалось отправить голосовое: ${msg}`);
    } finally {
      sendingRef.current = false;
      setUploading(false);
    }
  };

  // Авто-стоп на потолке длительности голосового
  useEffect(() => {
    if (state === 'recording' && elapsedMs >= maxMs) void finishAndSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, elapsedMs, maxMs]);

  if (state === 'unsupported') return null;

  if (uploading) {
    return (
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          height: '2.6rem',
          padding: '0 0.8rem',
          background: 'var(--surface-container-high)',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.78rem',
          color: 'var(--on-surface-variant)',
        }}
      >
        <span>🎤 Отправка… {progress}%</span>
      </div>
    );
  }

  if (state === 'recording') {
    return (
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '0.55rem',
          height: '2.6rem',
          padding: '0 0.55rem 0 0.8rem',
          background: 'var(--surface-container-high)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: '0.6rem',
            height: '0.6rem',
            borderRadius: '50%',
            background: 'var(--primary)',
            animation: 'sa6VoicePulse 1.1s ease-in-out infinite',
          }}
        />
        <span style={{ fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums', color: 'var(--on-surface)' }}>
          {formatElapsed(elapsedMs)}
        </span>
        <button
          onClick={cancel}
          title="Отменить запись"
          aria-label="Отменить запись"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '1rem',
            color: 'var(--on-surface-variant)',
            padding: '0 0.25rem',
          }}
        >
          ✕
        </button>
        <button
          onClick={() => void finishAndSend()}
          title="Отправить голосовое"
          aria-label="Отправить голосовое"
          style={{
            background: 'var(--primary)',
            color: 'var(--on-primary, #fff)',
            border: 'none',
            cursor: 'pointer',
            width: '2rem',
            height: '2rem',
            borderRadius: '50%',
            fontSize: '0.95rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ➤
        </button>
        <style>{`@keyframes sa6VoicePulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.8); } }`}</style>
      </div>
    );
  }

  return (
    <button
      onClick={() => void start()}
      title={state === 'denied' ? 'Доступ к микрофону запрещён — разрешите в настройках браузера' : 'Записать голосовое'}
      aria-label="Записать голосовое"
      style={{
        flexShrink: 0,
        background: 'var(--surface-container-high)',
        border: 'none',
        cursor: 'pointer',
        width: '2.6rem',
        height: '2.6rem',
        borderRadius: 'var(--radius-md)',
        fontSize: '1.15rem',
        color: 'var(--on-surface-variant)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: state === 'denied' ? 0.5 : 1,
      }}
    >
      🎤
    </button>
  );
}
