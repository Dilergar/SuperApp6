'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ChatCallStatePayload } from '@superapp/shared';
import { useAuthStore } from '@/lib/stores/auth';
import { callsStatusKey } from '@/lib/queries';
import { endCallSession, getCallsStatus, getMyActiveChatCalls } from '@/lib/calls-api';
import { useMessengerSocket } from '@/lib/hooks/useMessengerSocket';
import { PersonAvatar } from '@/app/messenger/messenger-ui';

/**
 * Глобальный слушатель входящих звонков (монтируется в Providers): дозвон ловится
 * на ЛЮБОЙ странице приложения, как в WhatsApp. Единственный источник модалки
 * входящего — страница мессенджера свою НЕ рендерит (двойного ринга нет).
 *
 * Ринг-условие (см. ChatCallStatePayload): DM ∧ звонок жив ∧ звонящий РЕАЛЬНО в
 * комнате (participants непусты — «токен взял и умер» не рингует) ∧ меня в комнате
 * нет ∧ не я звоню. Гашение: participants опустели / active=null / мой Accept/Decline /
 * локальный таймер. Холодная загрузка и reconnect — GET /messenger/calls/active.
 *
 * Побочный эффект (осознанный): сокет /messenger теперь живёт на всех страницах →
 * presence «онлайн» = «открыт SuperApp6», а не «открыт мессенджер».
 */
export function CallsWatcher() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const statusQ = useQuery({
    queryKey: callsStatusKey,
    queryFn: getCallsStatus,
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });
  if (!isAuthenticated || !meId || !statusQ.data?.enabled) return null;
  return <IncomingCallWatcher meId={meId} />;
}

function IncomingCallWatcher({ meId }: { meId: string }) {
  const router = useRouter();
  const [incoming, setIncoming] = useState<ChatCallStatePayload | null>(null);
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  // Сессии, по которым я уже решил (принял/отклонил) — не рингуем повторно в окне
  // «токен взят → participant_joined ещё не пришёл»
  const suppressedRef = useRef<Set<string>>(new Set());

  const decide = (p: ChatCallStatePayload) => {
    const cur = incomingRef.current;
    const alive = !!p.active && p.active.participantUserIds.length > 0;
    const meInside = !!p.active?.participantUserIds.includes(meId);
    if (!alive || meInside) {
      if (cur?.chatId === p.chatId) setIncoming(null);
      return;
    }
    const shouldRing =
      p.chatType === 'dm' &&
      p.active!.startedById !== meId &&
      !suppressedRef.current.has(p.active!.sessionId);
    if (shouldRing && (!cur || cur.chatId === p.chatId)) setIncoming(p);
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;

  const refetchActive = () => {
    getMyActiveChatCalls()
      .then((items) => items.forEach((i) => decideRef.current(i)))
      .catch(() => undefined);
  };

  useMessengerSocket({
    onCallState: (p) => decideRef.current(p),
    onReconnect: refetchActive,
  });

  // Холодная загрузка + периодический бэкстоп: сокет — основной канал, поллинг —
  // страховка at-most-once шины (participant_joined/session_ended может потеряться:
  // ack до хэндлера; сокет при этом жив — onReconnect не выстрелит). Тикаем ТОЛЬКО
  // на видимой вкладке: скрытые вкладки не жгут ~830 rps на платформу; на возврат
  // видимости — немедленный опрос, чтобы догнать пропущенный звонок/завершение.
  useEffect(() => {
    refetchActive();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refetchActive();
    }, 20_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refetchActive();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Локальный предохранитель: ринг сам гаснет через 60с даже без событий
  useEffect(() => {
    if (!incoming) return;
    const t = setTimeout(() => setIncoming(null), 60_000);
    return () => clearTimeout(t);
  }, [incoming]);

  // Рингтон: WebAudio-осциллятор (без бинарных ассетов). Autoplay-политика может
  // держать контекст suspended до первого жеста — тогда ринг только визуальный.
  useEffect(() => {
    if (!incoming) return;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      void ctx.resume().catch(() => undefined);
    } catch {
      return;
    }
    const beep = () => {
      if (!ctx || ctx.state !== 'running') return;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
      gain.connect(ctx.destination);
      for (const [freq, delay] of [[880, 0], [660, 0.45]] as const) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.4);
      }
    };
    beep();
    const interval = setInterval(beep, 2000);
    return () => {
      clearInterval(interval);
      void ctx?.close().catch(() => undefined);
    };
  }, [incoming ? incoming.active?.sessionId : null]);

  if (!incoming?.active) return null;
  const { active, chatId, startedByName } = incoming;

  const accept = () => {
    suppressedRef.current.add(active.sessionId);
    setIncoming(null);
    // cs=<sessionId> делает deep-link уникальным на каждый звонок (guard-ключ страницы)
    router.push(`/messenger?chat=${chatId}&call=join&cs=${active.sessionId}`);
  };
  const decline = () => {
    suppressedRef.current.add(active.sessionId);
    setIncoming(null);
    // DM: оба участника — модераторы → «Отклонить» гасит звонок у обоих
    endCallSession(active.sessionId).catch(() => undefined);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', pointerEvents: 'none' }}>
      <div
        className="card-elevated"
        style={{
          pointerEvents: 'auto',
          marginTop: '10vh',
          padding: 'var(--spacing-5)',
          minWidth: 300,
          maxWidth: 360,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--spacing-3)',
          background: 'var(--surface-container-lowest)',
          borderRadius: '1.2rem 0.9rem 1.1rem 0.95rem',
          boxShadow: '0 12px 40px color-mix(in srgb, var(--on-surface) 25%, transparent)',
        }}
      >
        <PersonAvatar userId={active.startedById} name={startedByName ?? 'Входящий звонок'} size="lg" />
        <div style={{ textAlign: 'center' }}>
          <div className="title-lg" style={{ fontSize: '1.05rem' }}>{startedByName ?? 'Входящий звонок'}</div>
          <div className="label-md" style={{ color: 'var(--on-surface-variant)' }}>📞 Входящий звонок…</div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
          <button className="btn-primary" style={{ padding: '0.6rem 1.4rem' }} onClick={accept}>
            Принять
          </button>
          <button className="btn-secondary" style={{ padding: '0.6rem 1.4rem' }} onClick={decline}>
            Отклонить
          </button>
        </div>
      </div>
    </div>
  );
}
