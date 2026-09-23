'use client';

// Части журнала безопасности, общие для трёх зрителей (человек, организация, Кабинет):
// актор события, строка ленты и модалка «Событие». Проекцию решил сервер — здесь
// только отрисовка того, что пришло: полного IP в DTO человека и организации нет вовсе.

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { AuditActorDto, SecurityEventDto } from '@superapp/shared';
import { Button, Chip, Divider, EmojiIcon, IconButton, Modal } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { BotChip } from '@/components/keys/BotChip';
import { useFormatters } from '@/lib/format';
import { eventIcon, eventTone, outcomeTone } from './event-visuals';

/** Кто совершил действие: человек — карточкой, бот — BotChip, остальные — словом в чипе. */
export function ActorView({ actor }: { actor: AuditActorDto }) {
  const t = useTranslations('audit');
  switch (actor.kind) {
    case 'user':
      return actor.person ? (
        <PersonChip size="S" userId={actor.person.id} firstName={actor.person.firstName} lastName={actor.person.lastName} avatar={actor.person.avatar} />
      ) : (
        <Chip tone="neutral" size="sm">{t('actorKinds.anonymous')}</Chip>
      );
    case 'bot':
      return <BotChip name={actor.name ?? t('actorKinds.bot')} size="xs" />;
    case 'platform_staff':
      return (
        <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {actor.person && <PersonChip size="S" userId={actor.person.id} firstName={actor.person.firstName} lastName={actor.person.lastName} avatar={actor.person.avatar} />}
          <Chip tone="accent" size="sm">{t('actorKinds.platform_staff')}</Chip>
        </span>
      );
    default:
      return <Chip tone="neutral" size="sm">{t(`actorKinds.${actor.kind}`)}</Chip>;
  }
}

/** «Chrome · Windows · Казахстан» — устройство и место одной строкой (без IP). */
export function useEventMeta(): (e: SecurityEventDto, withTime?: boolean) => string {
  const t = useTranslations('audit');
  const fmt = useFormatters();
  return (e, withTime = true) =>
    [e.device.label, e.location.country ? fmt.country(e.location.country) : null, withTime ? fmt.time(e.occurredAt) : null]
      .filter((x): x is string => !!x)
      .join(' · ') || t('unknownPlace');
}

/** Строка ленты — кнопка (Enter/Space открывают модалку события). */
export function SecurityEventRow({ event, onOpen }: { event: SecurityEventDto; onOpen: (e: SecurityEventDto) => void }) {
  const meta = useEventMeta();
  const tone = eventTone(event);
  return (
    <button
      type="button"
      className="ui-row"
      onClick={() => onOpen(event)}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', width: '100%', padding: 'var(--spacing-3)', textAlign: 'start', cursor: 'pointer', border: 'none', font: 'inherit', color: 'inherit' }}
    >
      <EmojiIcon emoji={eventIcon(event)} tone={tone} size={36} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
        <span className="title-sm" style={{ overflowWrap: 'anywhere' }}>{event.title}</span>
        <span className="label-sm">{meta(event)}</span>
      </span>
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, 30%) 1fr', gap: 'var(--spacing-3)', alignItems: 'baseline', padding: '0.375rem 0' }}>
      <span className="label-caps">{label}</span>
      <span className="body-sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

/**
 * Модалка «Событие». `viewer` меняет только подсказки и действия: у человека — «Это не я»
 * для оспоримого события и подсказка про IP; у Кабинета — слот `extra` (сеть, раскрытие IP).
 */
export function SecurityEventModal({
  event,
  open,
  onClose,
  viewer,
  onNotMe,
  workspaceName,
  extra,
}: {
  event: SecurityEventDto | null;
  open: boolean;
  onClose: () => void;
  viewer: 'person' | 'workspace' | 'platform';
  onNotMe?: (e: SecurityEventDto) => void;
  workspaceName?: string | null;
  extra?: ReactNode;
}) {
  const t = useTranslations('audit');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  const [copied, setCopied] = useState(false);
  if (!event) return null;
  const place = [event.location.city, event.location.country ? fmt.country(event.location.country) : null].filter(Boolean).join(', ');
  const copy = async () => {
    if (!event.requestId) return;
    try {
      await navigator.clipboard.writeText(event.requestId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* буфер недоступен (не secure context) — id виден и выделяется руками */
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={event.title}
      subtitle={event.body ?? undefined}
      footer={
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {viewer === 'person' && event.disputable && onNotMe && (
            <Button variant="primary" tone="danger" icon="shieldWarning" onClick={() => onNotMe(event)}>{t('ui.event.notMe')}</Button>
          )}
          <Button variant="ghost" onClick={onClose}>{tc('actions.close')}</Button>
        </div>
      }
    >
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Chip tone={outcomeTone(event.outcome)} size="sm">{t(`outcomes.${event.outcome}`)}</Chip>
        <Chip tone="neutral" size="sm">{t(`categories.${event.category}`)}</Chip>
        {(event.severity === 'high' || event.severity === 'critical') && <Chip tone={eventTone(event) === 'danger' ? 'danger' : 'warning'} size="sm">{t(`severities.${event.severity}`)}</Chip>}
      </div>
      <Divider />
      <Row label={t('ui.event.when')}>{fmt.dateTime(event.occurredAt)}</Row>
      {viewer !== 'person' && <Row label={t('ui.event.who')}><ActorView actor={event.actor} /></Row>}
      {viewer !== 'person' && event.subject && (
        <Row label={t('ui.event.subject')}>
          <PersonChip size="S" userId={event.subject.id} firstName={event.subject.firstName} lastName={event.subject.lastName} avatar={event.subject.avatar} />
        </Row>
      )}
      {/* Сырой id цели (строка сессии, устройства) человеку ничего не говорит — только Кабинету */}
      {event.target && (event.target.person || event.target.label || viewer === 'platform') && (
        <Row label={t('ui.event.target')}>
          {event.target.person ? (
            <PersonChip size="S" userId={event.target.person.id} firstName={event.target.person.firstName} lastName={event.target.person.lastName} avatar={event.target.person.avatar} />
          ) : (
            <span>{event.target.label ?? event.target.id}</span>
          )}
        </Row>
      )}
      {event.device.label && <Row label={t('ui.event.device')}>{event.device.label}</Row>}
      <Row label={t('ui.event.where')}>{place ? (event.location.city ? t('ui.event.approx', { place }) : place) : t('unknownPlace')}</Row>
      {event.client && <Row label={t('ui.event.app')}>{t(`clients.${event.client}`)}</Row>}
      {event.reasonCode && t.has(`reasons.${event.reasonCode}`) && <Row label={t('ui.event.reason')}>{t(`reasons.${event.reasonCode}`)}</Row>}
      {typeof event.details.source === 'string' && t.has(`exportSources.${event.details.source}`) && (
        <Row label={t('ui.event.source')}>{t(`exportSources.${event.details.source}`)}</Row>
      )}
      {event.workspaceId && workspaceName && <Row label={t('ui.event.organization')}>{workspaceName}</Row>}
      {event.requestId && (
        <Row label={t('ui.event.requestId')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
            <code style={{ fontSize: '0.75rem', overflowWrap: 'anywhere' }}>{event.requestId}</code>
            <IconButton icon={copied ? 'check' : 'copy'} label={copied ? t('ui.event.copied') : t('ui.event.copy')} size={28} onClick={() => void copy()} />
          </span>
        </Row>
      )}
      {extra}
      {viewer !== 'platform' && (
        <p className="label-sm" style={{ marginTop: 'var(--spacing-4)', lineHeight: 1.5 }}>
          {viewer === 'person' ? t('ui.event.ipHintPerson') : t('ui.event.ipHintWorkspace')}
        </p>
      )}
    </Modal>
  );
}
