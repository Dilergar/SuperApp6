'use client';

import { useEffect, useRef, useState } from 'react';
import type { CallActiveDto, CallTokenDto, ChatType } from '@superapp/shared';
import { CALL_LIMITS } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import {
  claimCallRecording,
  endCallSession,
  getCallToken,
  startCallRecording,
  stopCallRecording,
} from '@/lib/calls-api';
import { CallRoomShell, type CallLeaveReason } from '@/components/calls/CallRoomShell';
import { CallStage } from '@/components/calls/CallStage';
import { ControlsBar } from '@/components/calls/ControlsBar';
import { PersonAvatar } from './messenger-ui';

/**
 * Полноэкранный оверлей звонка поверх /messenger (Telegram Web-модель, WhatsApp-флоу):
 * PreJoin скипается — старт сразу с микрофоном и БЕЗ камеры (включается внутри),
 * устройства берутся из сохранённого выбора PreJoin офиса (sa6_call_devices).
 *
 * DM-семантика (WhatsApp): «Покинуть» = положить трубку = звонок завершается для
 * обоих (оба участника DM — модераторы движка); дозвон — caller-таймер 45с, если
 * собеседник так и не подключился → отменяем сами («Пропущенный» поставит бэкенд).
 * Группа/контекстный чат: выход не завершает звонок; «Завершить для всех» — owner/admin.
 */
export function CallOverlay({
  chatId,
  chatType,
  title,
  peerUserId,
  peerAvatar,
  active,
  recordingEnabled,
  onClose,
}: {
  chatId: string;
  chatType: ChatType;
  title: string;
  peerUserId?: string | null;
  peerAvatar?: string | null;
  /** Живой снимок звонка этого чата (call:state) — «Звоним…» и ринг-таймер */
  active: CallActiveDto | null;
  /** Egress поднят — показываем ⏺ (GET /calls/status.recordingEnabled) */
  recordingEnabled?: boolean;
  onClose: (reason: CallLeaveReason | 'cancelled') => void;
}) {
  const [call, setCall] = useState<CallTokenDto | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const callRef = useRef<CallTokenDto | null>(null);
  callRef.current = call;

  const isDm = chatType === 'dm';
  const peerJoined = !isDm || !peerUserId || !!active?.participantUserIds?.includes(peerUserId);

  // Токен входа (доступ решает резолвер 'chat' на бэке; сессия get-or-create)
  useEffect(() => {
    let cancelled = false;
    getCallToken({ refType: 'chat', refId: chatId })
      .then((t) => { if (!cancelled) setCall(t); })
      .catch((e) => {
        if (!cancelled) {
          alert(apiErrorMessage(e));
          onCloseRef.current('error');
        }
      });
    return () => { cancelled = true; };
  }, [chatId]);

  // DM-дозвон: собеседник не подключился за dmRingTimeoutSec → отменяем звонок сами
  // (LiveKit сам ничего не «прозванивает»; «Пропущенный звонок» поставит листенер бэка)
  const peerJoinedRef = useRef(peerJoined);
  peerJoinedRef.current = peerJoined;
  useEffect(() => {
    if (!isDm || !call) return;
    const timer = setTimeout(() => {
      if (peerJoinedRef.current) return;
      endCallSession(call.sessionId).catch(() => undefined);
      onCloseRef.current('cancelled');
    }, CALL_LIMITS.dmRingTimeoutSec * 1000);
    return () => clearTimeout(timer);
  }, [isDm, call]);

  // Вкладка закрывается посреди DM-звонка → best-effort «повесить трубку» для обоих
  // (keepalive-fetch переживает pagehide; страхуют departure_timeout LiveKit + крон)
  useEffect(() => {
    if (!isDm) return;
    const onPageHide = () => {
      const c = callRef.current;
      if (!c) return;
      const token = localStorage.getItem('accessToken');
      if (!token) return;
      const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
      void fetch(`${base}/calls/rooms/${c.sessionId}/end`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [isDm]);

  // SPA-навигация («Назад» браузера, переход по ссылке) размонтирует оверлей, но НЕ
  // стреляет pagehide, а CallRoomShell на unmount глушит onLeft (cancelled) → DM-звонок
  // остался бы «живым» у собеседника. Кладём трубку явно на размонтировании (для DM).
  // callRef.current в момент StrictMode-двойного unmount ещё null (токен не пришёл) → без ложного end.
  useEffect(() => {
    if (!isDm) return;
    return () => {
      const c = callRef.current;
      if (c) endCallSession(c.sessionId).catch(() => undefined);
    };
  }, [isDm]);

  const handleLeft = (reason: CallLeaveReason) => {
    // DM: мой выход = конец звонка для обоих (fire-and-forget; на 'ended'/'kicked'
    // сессию уже закрыли за нас)
    if (isDm && reason === 'left' && callRef.current) {
      endCallSession(callRef.current.sessionId).catch(() => undefined);
    }
    onCloseRef.current(reason);
  };

  // Устройства — из сохранённого выбора PreJoin (ключ общий с офисом)
  let audioDeviceId: string | undefined;
  let videoDeviceId: string | undefined;
  try {
    const prefs = JSON.parse(localStorage.getItem('sa6_call_devices') ?? '{}');
    audioDeviceId = prefs.audioDeviceId;
    videoDeviceId = prefs.videoDeviceId;
  } catch { /* приватный режим */ }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 130,
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        padding: 'var(--spacing-4)',
        gap: 'var(--spacing-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
        <PersonAvatar userId={isDm ? peerUserId : undefined} name={title} avatar={peerAvatar} size="md" />
        <div style={{ minWidth: 0 }}>
          <div className="title-lg" style={{ fontSize: '1.05rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            📞 {title}
          </div>
          <div className="label-md" style={{ color: 'var(--on-surface-variant)' }}>
            {!call
              ? 'Подключение…'
              : isDm && !peerJoined
                ? 'Звоним…'
                : `Участников: ${active?.participantUserIds?.length ?? 1}${active?.recording ? ' · ● Запись' : ''}`}
          </div>
        </div>
      </div>

      {call ? (
        <CallRoomShell
          token={call.token}
          wsUrl={call.wsUrl}
          audioEnabled={true}
          videoEnabled={false}
          audioDeviceId={audioDeviceId}
          videoDeviceId={videoDeviceId}
          onLeft={handleLeft}
        >
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
            <CallStage />
            <ControlsBar
              // DM: «Завершить для всех» прячем — «Покинуть» и есть трубка (см. handleLeft)
              moderator={!isDm && call.moderator}
              onEndForAll={() => {
                if (confirm('Завершить звонок для всех участников?')) {
                  endCallSession(call.sessionId).catch((e) => alert(apiErrorMessage(e)));
                }
              }}
              extra={
                recordingEnabled ? (
                  <RecordingControls sessionId={call.sessionId} recording={!!active?.recording} />
                ) : undefined
              }
            />
          </div>
        </CallRoomShell>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p className="label-md">Подключение к звонку…</p>
        </div>
      )}
    </div>
  );
}

/**
 * ⏺/⏹ запись + «Получить запись» (модель Zoom: любой участник включает, все видят
 * «● Запись»; каждый нажавший «Получить» найдёт ПОЛНУЮ запись в своём Диктофоне,
 * раздел «Журнал звонков»; инициатор получает автоматически).
 */
function RecordingControls({ sessionId, recording }: { sessionId: string; recording: boolean }) {
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState(false);
  // Новая запись в этом же звонке (стоп → снова ⏺) — клейм нужно жать заново
  const prevRecording = useRef(recording);
  const justStartedByMe = useRef(false);
  useEffect(() => {
    if (recording && !prevRecording.current && !justStartedByMe.current) setClaimed(false);
    if (recording) justStartedByMe.current = false;
    prevRecording.current = recording;
  }, [recording]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      alert(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!recording) {
    return (
      <button
        onClick={() =>
          void run(async () => {
            justStartedByMe.current = true;
            await startCallRecording(sessionId);
            setClaimed(true); // инициатор — клеймант автоматически
          })
        }
        disabled={busy}
        title="Записать звонок (аудио; все участники увидят индикатор)"
        style={{
          padding: '0.55rem 1rem',
          fontSize: '0.85rem',
          fontWeight: 700,
          border: 'none',
          cursor: 'pointer',
          borderRadius: '0.8rem 0.55rem 0.75rem 0.6rem',
          background: 'var(--surface-container-high)',
        }}
      >
        ⏺ Запись
      </button>
    );
  }
  return (
    <>
      <span
        className="label-md"
        style={{ color: 'var(--primary)', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.3rem' }}
        title="Идёт запись звонка"
      >
        ● Запись
      </span>
      <button
        onClick={() => void run(() => stopCallRecording(sessionId))}
        disabled={busy}
        title="Остановить запись (инициатор или модератор)"
        style={{
          padding: '0.55rem 0.9rem',
          fontSize: '0.85rem',
          border: 'none',
          cursor: 'pointer',
          borderRadius: '0.8rem 0.55rem 0.75rem 0.6rem',
          background: 'var(--surface-container-high)',
        }}
      >
        ⏹
      </button>
      <button
        onClick={() =>
          void run(async () => {
            await claimCallRecording(sessionId);
            setClaimed(true);
          })
        }
        disabled={busy || claimed}
        title="Полная запись придёт в ваш Диктофон → «Журнал звонков»"
        className="btn-secondary"
        style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', opacity: claimed ? 0.7 : 1 }}
      >
        {claimed ? '✓ Придёт в Диктофон' : 'Получить запись'}
      </button>
    </>
  );
}
