'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Track } from 'livekit-client';
import { useParticipants } from '@livekit/components-react';
import { useConfirm } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { kickCallParticipant, muteCallTrack } from '@/lib/calls-api';
import { ConnectionQualityBadge } from './CallResilience';
import { toastError } from '@/lib/toast';

/**
 * Панель «Участники» живого звонка: PersonChip (принцип 2) + модератору
 * kick / принудительный mute (через серверные эндпоинты движка — LiveKit сам
 * доставит участнику disconnect/mute).
 */
export function ParticipantsPanel({
  sessionId,
  moderator,
  currentUserId,
}: {
  sessionId: string;
  moderator: boolean;
  currentUserId: string;
}) {
  const t = useTranslations('calls');
  const participants = useParticipants();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, confirmUI] = useConfirm();

  const kick = (identity: string, name: string) => {
    confirm(
      {
        title: t('panel.kickTitle', { name }),
        message: t('panel.kickMessage'),
        confirmLabel: t('panel.kickConfirm'),
        danger: true,
      },
      () => kickNow(identity),
    );
  };

  const kickNow = async (identity: string) => {
    setBusyId(identity);
    try {
      await kickCallParticipant(sessionId, identity);
    } catch {
      toastError(t('panel.kickFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const muteMic = async (identity: string) => {
    const p = participants.find((x) => x.identity === identity);
    const sid = p?.getTrackPublication(Track.Source.Microphone)?.trackSid;
    if (!sid) return;
    setBusyId(identity);
    try {
      await muteCallTrack(sessionId, identity, sid, true);
    } catch {
      toastError(t('panel.muteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      {participants.map((p) => {
        const micOn = p.isMicrophoneEnabled;
        const me = p.identity === currentUserId;
        return (
          <div
            key={p.identity}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--spacing-2)',
              padding: '0.3rem 0.4rem',
              borderRadius: 'var(--radius-sketch)',
              background: 'var(--surface-container)',
            }}
          >
            <PersonChip size="S" userId={p.identity} firstName={p.name || t('tile.participant')} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
              <ConnectionQualityBadge participant={p} />
              <span title={micOn ? t('panel.micOn') : t('panel.micOff')} style={{ fontSize: '0.85rem', opacity: micOn ? 1 : 0.6 }}>
                {micOn ? '🎤' : '🔇'}
              </span>
              {moderator && !me && (
                <>
                  {micOn && (
                    <button
                      onClick={() => void muteMic(p.identity)}
                      disabled={busyId === p.identity}
                      title={t('panel.mute')}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}
                    >
                      🤫
                    </button>
                  )}
                  <button
                    onClick={() => void kick(p.identity, p.name || t('panel.thisPerson'))}
                    disabled={busyId === p.identity}
                    title={t('panel.kick')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 700, fontSize: '0.85rem' }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {participants.length === 0 && <p className="label-sm">{t('panel.empty')}</p>}
      {confirmUI}
    </div>
  );
}
