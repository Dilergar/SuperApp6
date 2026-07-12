'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================
// Запись голоса в браузере (MediaRecorder) — общий хук голосового
// движка: голосовые в мессенджере + запись в Диктофоне.
// Чистый звук — браузерные constraints (шумодав/эхо/автоусиление);
// формат: webm/opus (Chrome/Edge/Firefox) → mp4 (Safari) → ogg.
// ============================================================

export type VoiceRecorderState = 'idle' | 'recording' | 'denied' | 'unsupported';

const MIME_CASCADE: Array<{ mime: string; ext: string }> = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
];

function pickMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const c of MIME_CASCADE) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      // некоторые браузеры кидают на незнакомом контейнере
    }
  }
  return null;
}

export function useVoiceRecorder() {
  const [state, setState] = useState<VoiceRecorderState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<{ mime: string; ext: string } | null>(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (recorderRef.current) return false;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || !pickMime()) {
      setState('unsupported');
      return false;
    }
    try {
      // Клиентский шумодав — главный вклад в «чистый звук» голосовых.
      // channelCount 1 — речь пишем в моно (меньше вес, STT всё равно моно)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const picked = pickMime();
      if (!picked) {
        stream.getTracks().forEach((t) => t.stop());
        setState('unsupported');
        return false;
      }
      const recorder = new MediaRecorder(stream, { mimeType: picked.mime, audioBitsPerSecond: 64_000 });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(1000); // timeslice: данные копятся раз в секунду — краш не теряет всё
      recorderRef.current = recorder;
      streamRef.current = stream;
      mimeRef.current = picked;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setState('recording');
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
      return true;
    } catch (err) {
      setState(err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'unsupported');
      return false;
    }
  }, []);

  /** Остановить и получить файл записи (null, если ничего не записано) */
  const stop = useCallback((): Promise<File | null> => {
    const recorder = recorderRef.current;
    const picked = mimeRef.current;
    if (!recorder || !picked) return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.onstop = () => {
        stopTimer();
        releaseStream();
        recorderRef.current = null;
        setState('idle');
        const blobs = chunksRef.current;
        chunksRef.current = [];
        if (!blobs.length) {
          resolve(null);
          return;
        }
        const baseMime = picked.mime.split(';')[0];
        const blob = new Blob(blobs, { type: baseMime });
        resolve(new File([blob], `voice-${Date.now()}.${picked.ext}`, { type: baseMime }));
      };
      try {
        recorder.stop();
      } catch {
        stopTimer();
        releaseStream();
        recorderRef.current = null;
        setState('idle');
        resolve(null);
      }
    });
  }, [releaseStream, stopTimer]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    chunksRef.current = [];
    stopTimer();
    if (recorder) {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      try {
        recorder.stop();
      } catch {
        // уже остановлен
      }
    }
    releaseStream();
    setState('idle');
    setElapsedMs(0);
  }, [releaseStream, stopTimer]);

  // Уход со страницы/размонтирование — микрофон отпускаем всегда
  useEffect(() => cancel, [cancel]);

  return { state, elapsedMs, start, stop, cancel };
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
