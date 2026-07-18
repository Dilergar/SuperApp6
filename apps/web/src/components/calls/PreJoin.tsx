'use client';

import { useEffect, useRef, useState } from 'react';

export interface PreJoinChoice {
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}

const PREFS_KEY = 'sa6_call_devices';

function loadPrefs(): Partial<PreJoinChoice> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Экран перед входом (как в Meet): превью камеры, выбор устройств, тумблеры
 * микрофона/камеры. Выбор запоминается в localStorage. Треки превью честно
 * останавливаются при unmount — камера не остаётся «занятой».
 */
export function PreJoin({
  title,
  joining,
  error,
  onJoin,
}: {
  title: string;
  joining?: boolean;
  error?: string | null;
  onJoin: (choice: PreJoinChoice) => void;
}) {
  const prefs = useRef(loadPrefs());
  const [audioEnabled, setAudioEnabled] = useState(prefs.current.audioEnabled ?? true);
  const [videoEnabled, setVideoEnabled] = useState(prefs.current.videoEnabled ?? true);
  const [audioDeviceId, setAudioDeviceId] = useState<string | undefined>(prefs.current.audioDeviceId);
  const [videoDeviceId, setVideoDeviceId] = useState<string | undefined>(prefs.current.videoDeviceId);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Превью: один stream (audio для разрешения/лейблов устройств, video по тумблеру)
  useEffect(() => {
    let localStream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: audioDeviceId ? { deviceId: { ideal: audioDeviceId } } : true,
          video: videoEnabled
            ? videoDeviceId
              ? { deviceId: { ideal: videoDeviceId } }
              : true
            : false,
        });
        if (cancelled) {
          localStream.getTracks().forEach((t) => t.stop());
          return;
        }
        setMediaError(null);
        setStream(localStream);
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) {
          setMics(devices.filter((d) => d.kind === 'audioinput'));
          setCams(devices.filter((d) => d.kind === 'videoinput'));
        }
      } catch {
        if (!cancelled) {
          setStream(null);
          setMediaError('Нет доступа к камере/микрофону — проверьте разрешения браузера');
        }
      }
    })();
    return () => {
      cancelled = true;
      localStream?.getTracks().forEach((t) => t.stop());
    };
  }, [videoEnabled, audioDeviceId, videoDeviceId]);

  // Присвоение потока в <video> — ОТДЕЛЬНЫМ эффектом: при восстановлении после ошибки
  // элемент <video> был размонтирован (рендерится только при !mediaError), поэтому
  // присвоить srcObject в том же тике, что setMediaError(null), нельзя — videoRef ещё null.
  useEffect(() => {
    const v = videoRef.current;
    if (v && stream && videoEnabled && !mediaError) {
      v.srcObject = stream;
      void v.play().catch(() => {});
    }
  }, [stream, videoEnabled, mediaError]);

  const join = () => {
    const choice: PreJoinChoice = { audioEnabled, videoEnabled, audioDeviceId, videoDeviceId };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(choice));
    } catch {
      /* приватный режим — не критично */
    }
    onJoin(choice);
  };

  const toggleStyle = (on: boolean): React.CSSProperties => ({
    width: '3rem',
    height: '3rem',
    borderRadius: '1rem 0.7rem 1.1rem 0.8rem',
    border: 'none',
    cursor: 'pointer',
    fontSize: '1.15rem',
    background: on ? 'var(--surface-container-high)' : 'var(--primary)',
    color: on ? 'inherit' : 'white',
  });

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <h1 className="display-md" style={{ fontSize: '1.6rem', marginBottom: 'var(--spacing-5)' }}>
        {title}
      </h1>

      {/* Превью камеры */}
      <div
        style={{
          position: 'relative',
          aspectRatio: '16 / 10',
          borderRadius: 'var(--radius-sketch)',
          overflow: 'hidden',
          background: 'var(--surface-dim)',
          marginBottom: 'var(--spacing-4)',
        }}
      >
        {videoEnabled && !mediaError ? (
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 'var(--spacing-2)',
            }}
          >
            <span style={{ fontSize: '2.4rem' }}>🎥</span>
            <span className="label-md">{mediaError ?? 'Камера выключена'}</span>
          </div>
        )}
        {/* Тумблеры поверх превью */}
        <div
          style={{
            position: 'absolute',
            bottom: 'var(--spacing-3)',
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            gap: 'var(--spacing-3)',
          }}
        >
          <button
            onClick={() => setAudioEnabled((v) => !v)}
            title={audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
            style={toggleStyle(audioEnabled)}
          >
            {audioEnabled ? '🎤' : '🔇'}
          </button>
          <button
            onClick={() => setVideoEnabled((v) => !v)}
            title={videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
            style={toggleStyle(videoEnabled)}
          >
            {videoEnabled ? '🎥' : '📷'}
          </button>
        </div>
      </div>

      {/* Устройства */}
      {(mics.length > 0 || cams.length > 0) && (
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
          {mics.length > 0 && (
            <label className="label-md" style={{ flex: 1, minWidth: 200 }}>
              Микрофон
              <select
                value={audioDeviceId ?? ''}
                onChange={(e) => setAudioDeviceId(e.target.value || undefined)}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.4rem 0.5rem', background: 'var(--surface-container)', border: 'none', borderRadius: 'var(--radius-sketch)' }}
              >
                <option value="">По умолчанию</option>
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || 'Микрофон'}</option>
                ))}
              </select>
            </label>
          )}
          {cams.length > 0 && (
            <label className="label-md" style={{ flex: 1, minWidth: 200 }}>
              Камера
              <select
                value={videoDeviceId ?? ''}
                onChange={(e) => setVideoDeviceId(e.target.value || undefined)}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.4rem 0.5rem', background: 'var(--surface-container)', border: 'none', borderRadius: 'var(--radius-sketch)' }}
              >
                <option value="">По умолчанию</option>
                {cams.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || 'Камера'}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {error && (
        <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      <button className="btn-primary" onClick={join} disabled={joining} style={{ fontSize: '1rem', padding: '0.7rem 2.2rem' }}>
        {joining ? 'Подключение…' : 'Присоединиться'}
      </button>
    </div>
  );
}
