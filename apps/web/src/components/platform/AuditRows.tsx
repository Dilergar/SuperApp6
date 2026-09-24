'use client';

import { opaqueIdTail } from '@superapp/shared';
import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PlatformAuditEntryDto, PlatformAuditPageDto } from '@superapp/shared';
import { Chip, Table, TableCell, TableRow, type Tone } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { useFormatters } from '@/lib/format';
import { RISK_TONE } from './CommandRunner';

const OUTCOME_TONE: Record<PlatformAuditEntryDto['outcome'], Tone> = { ok: 'success', denied: 'warning', error: 'danger' };

/** Строки журнала (страница «Журнал» и панель «Лента» карточки). Раскрытие — вход, «было → стало», причина, заявка. */
export function AuditRows({ page, compact = false }: { page: PlatformAuditPageDto; compact?: boolean }) {
  const t = useTranslations('platform');
  const f = useFormatters();
  const [open, setOpen] = useState<string | null>(null);
  const columns = [
    { key: 'at', label: t('audit.col.at'), width: 'max-content' },
    { key: 'actor', label: t('audit.col.actor'), width: 'max-content', hideOnMobile: compact },
    { key: 'command', label: t('audit.col.command') },
    { key: 'target', label: t('audit.col.target'), hideOnMobile: true },
    { key: 'outcome', label: t('audit.col.outcome'), width: 'max-content' },
  ];
  if (!page.items.length) return <p className="label-sm">{t('audit.empty')}</p>;
  return (
    <Table columns={columns} lines aria-label={t('nav.audit')} aria-rowcount={page.items.length}>
      {page.items.map((e, i) => (
        <RowWithDetails key={e.id} entry={e} index={i + 1} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
      ))}
    </Table>
  );
}

function RowWithDetails({ entry: e, index, open, onToggle }: { entry: PlatformAuditEntryDto; index: number; open: boolean; onToggle: () => void }) {
  const t = useTranslations('platform');
  const f = useFormatters();
  const name = e.actor ? `${e.actor.firstName} ${e.actor.lastName ?? ''}`.trim() : t('audit.system');
  return (
    <>
      <TableRow rowIndex={index} onClick={onToggle} selected={open} style={e.outcome === 'denied' ? { background: 'color-mix(in srgb, var(--warning) 8%, transparent)' } : undefined}>
        <TableCell>{f.dateTime(e.occurredAt)}</TableCell>
        <TableCell>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
            {e.actor && <PersonAvatar userId={e.actor.id} name={name} avatar={e.actor.avatar} size="sm" />}
            <span className="body-sm">{name}</span>
          </span>
        </TableCell>
        <TableCell>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
            <code style={{ fontSize: '0.75rem' }}>{e.commandKey}</code>
            <Chip tone={RISK_TONE[e.risk]} size="sm">{t(`risk.${e.risk}`)}</Chip>
            {e.dryRun && <Chip tone="neutral" size="sm">{t('audit.dryRun')}</Chip>}
            {e.approvalId && <Chip tone="accent" size="sm" icon="people">{t('audit.viaRequest')}</Chip>}
          </span>
        </TableCell>
        <TableCell hideOnMobile>
          {e.targetType && e.targetId ? (
            e.targetType === 'user' || e.targetType === 'workspace' ? (
              <Link href={`/platform/${e.targetType === 'user' ? 'users' : 'workspaces'}/${e.targetId}`} className="label-sm">{`${e.targetType} · ${opaqueIdTail(e.targetId, 8)}`}</Link>
            ) : (
              <span className="label-sm">{`${e.targetType} · ${opaqueIdTail(e.targetId, 8)}`}</span>
            )
          ) : (
            <span className="label-sm">—</span>
          )}
        </TableCell>
        <TableCell>
          <Chip tone={OUTCOME_TONE[e.outcome]} size="sm">{t(`audit.outcome.${e.outcome}`)}{e.errorCode ? ` · ${e.errorCode}` : ''}</Chip>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow rowIndex={index}>
          <TableCell>
            <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: 'var(--spacing-4)', padding: 'var(--spacing-2) 0' }}>
              <div>
                <span className="label-caps">{t('audit.input')}</span>
                <pre style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{JSON.stringify(e.input, null, 1)}</pre>
              </div>
              {(e.before !== null || e.after !== null) && (
                <>
                  <div>
                    <span className="label-caps">{t('audit.before')}</span>
                    <pre style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{JSON.stringify(e.before, null, 1)}</pre>
                  </div>
                  <div>
                    <span className="label-caps">{t('audit.after')}</span>
                    <pre style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{JSON.stringify(e.after, null, 1)}</pre>
                  </div>
                </>
              )}
              <div className="ui-stack" style={{ gap: '0.25rem' }}>
                {e.reason && <span className="body-sm"><span className="label-caps">{t('audit.reason')}</span> {e.reason}</span>}
                {e.ticketRef && <span className="body-sm"><span className="label-caps">{t('audit.ticket')}</span> {e.ticketRef}</span>}
                {e.approvalId && <span className="body-sm"><span className="label-caps">{t('audit.approval')}</span> {opaqueIdTail(e.approvalId, 8)}</span>}
                {e.stepUpAt && <span className="label-sm">{t('audit.stepUpAt', { time: f.dateTime(e.stepUpAt) })}</span>}
                {e.ip && <span className="label-sm">{e.ip}</span>}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
