'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NOTE_LIMITS, NOTE_STT_LANGUAGE_STORAGE_KEY, VOICE_LANGUAGES, VOICE_LANGUAGE_LABELS, type VoiceLanguage } from '@superapp/shared';
import { IconButton, Menu } from '@/components/ui';
import { useVoiceRecorder } from '@/lib/hooks/useVoiceRecorder';
import { voiceStatusKey } from '@/lib/queries';
import { getVoiceStatus, sttSync } from '@/lib/voice-api';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';

// ============================================================
// Диктовка в заметку: кнопка-тумблер (нажал — говоришь — нажал), таймер, потом
// синхронный STT (`POST /voice/stt`) и текст встаёт в позицию каретки. Аудио не
// хранится (модель Apple Notes). Язык авто/рус/каз/eng запоминается в localStorage.
// Кнопка не показывается, если STT в среде выключен — UI несуществующего не рисуем.
// ============================================================

export function DictateButton({ onText, compact }: { onText: (text: string) => void; compact?: boolean }) {
  const status = useQuery({ queryKey: voiceStatusKey, queryFn: getVoiceStatus, staleTime: 10 * 60 * 1000 });
  const rec = useVoiceRecorder();
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState<VoiceLanguage>('auto');
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);

  // localStorage — только в эффекте (SSR/гидратация)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(NOTE_STT_LANGUAGE_STORAGE_KEY) as VoiceLanguage | null;
      if (saved && (VOICE_LANGUAGES as readonly string[]).includes(saved)) setLang(saved);
    } catch {
      /* приватный режим */
    }
  }, []);

  const pickLang = (l: VoiceLanguage) => {
    setLang(l);
    try {
      localStorage.setItem(NOTE_STT_LANGUAGE_STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  };

  const stopAndTranscribe = async () => {
    if (autoStop.current) clearTimeout(autoStop.current);
    autoStop.current = null;
    const file = await rec.stop();
    if (!file) return;
    setBusy(true);
    try {
      const res = await sttSync(file, lang === 'auto' ? undefined : lang);
      const text = res.text.trim();
      if (text) onText(text);
      else toastError('Речь не распознана — попробуйте ещё раз');
    } catch (e) {
      toastError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (rec.state === 'recording') {
      await stopAndTranscribe();
      return;
    }
    const ok = await rec.start();
    if (!ok) {
      toastError(rec.state === 'denied' ? 'Нет доступа к микрофону' : 'Запись в этом браузере не поддерживается');
      return;
    }
    autoStop.current = setTimeout(() => void stopAndTranscribe(), NOTE_LIMITS.dictationMaxSeconds * 1000);
  };

  useEffect(
    () => () => {
      if (autoStop.current) clearTimeout(autoStop.current);
    },
    [],
  );

  if (!status.data?.enabled) return null;
  const recording = rec.state === 'recording';
  const secs = Math.floor(rec.elapsedMs / 1000);
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <span className={`ne-dictate${recording ? ' ne-dictate--on' : ''}`}>
      <IconButton
        icon={recording ? 'stop' : 'mic'}
        label={recording ? `Остановить запись (${mmss})` : busy ? 'Распознаём…' : 'Надиктовать текст'}
        size={30}
        iconSize={16}
        disabled={busy}
        aria-pressed={recording}
        className={recording ? 'ne-tb-on' : undefined}
        onClick={() => void toggle()}
      />
      {recording && (
        <span className="ne-dictate-timer label-sm" aria-live="polite">
          <span className="ne-dictate-dot" aria-hidden /> {mmss}
        </span>
      )}
      {!compact && !recording && (
        <Menu
          label="Язык диктовки"
          align="end"
          items={VOICE_LANGUAGES.map((l) => ({ key: l, label: `${VOICE_LANGUAGE_LABELS[l]}${l === lang ? ' ✓' : ''}`, onClick: () => pickLang(l) }))}
          trigger={({ ref, onClick, ...aria }) => (
            <button ref={ref} type="button" onClick={onClick} {...aria} className="ne-dictate-lang label-sm" aria-label={`Язык диктовки: ${VOICE_LANGUAGE_LABELS[lang]}`}>
              {lang === 'auto' ? 'Авто' : lang.toUpperCase()}
            </button>
          )}
        />
      )}
    </span>
  );
}
