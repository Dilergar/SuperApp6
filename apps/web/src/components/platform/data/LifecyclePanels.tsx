'use client';

import { useTranslations } from 'next-intl';
import type { LifecycleErasureStatus, PlatformLifecycleExportLineDto, PlatformUserLifecyclePanelDto, PlatformWorkspaceLifecyclePanelDto } from '@superapp/shared';
import { Chip, type Tone } from '@/components/ui';
import { useBytes, useFormatters } from '@/lib/format';
import { useDurationLabel } from '@/components/lifecycle/duration';
import { Fact } from './data-ui';

export function erasureTone(status: LifecycleErasureStatus): Tone {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'held') return 'waiting';
  if (status === 'cancelled') return 'neutral';
  return 'accent';
}

const EXPORT_TONE: Record<PlatformLifecycleExportLineDto['status'], Tone> = { queued: 'waiting', running: 'accent', ready: 'success', failed: 'warning', expired: 'neutral' };

/** Выгрузки субъекта (Э6): вид (переносимая / восстановление), статус, объём, выдачи ссылок. */
function ExportLines({ items }: { items: PlatformLifecycleExportLineDto[] }) {
  const t = useTranslations('platform');
  const fmt = useFormatters();
  const bytes = useBytes();
  return (
    <>
      <span className="label-caps" style={{ marginTop: 'var(--spacing-2)' }}>{t('data.panel.exports')}</span>
      {items.length === 0 ? (
        <span className="label-sm">{t('data.panel.noExports')}</span>
      ) : (
        items.map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip size="sm" tone={EXPORT_TONE[e.status]}>{t(`data.exportStatus.${e.status}`)}</Chip>
            {e.mode === 'restore' && <Chip size="sm" tone="neutral" icon="archive">{t('data.panel.restoreArchive')}</Chip>}
            <span className="label-sm">{t('data.panel.exportLine', { date: fmt.date(e.createdAt), size: bytes(e.bytes), downloads: e.downloads })}</span>
          </div>
        ))
      )}
    </>
  );
}

/** Панель «Данные» карточки человека: удаление аккаунта, заявки на стирание, заморозки хранителя, выгрузки. */
export function UserLifecyclePanel({ data }: { data: PlatformUserLifecyclePanelDto }) {
  const t = useTranslations('platform');
  const fmt = useFormatters();
  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
      <Fact label={t('data.panel.deletionScheduled')} value={data.deletionScheduledAt ? fmt.date(data.deletionScheduledAt) : t('data.panel.notScheduled')} />
      <Fact label={t('data.panel.custodianHolds')} value={data.custodianHolds > 0 ? <Chip size="sm" tone="waiting" icon="lock">{fmt.number(data.custodianHolds)}</Chip> : fmt.number(0)} />
      <span className="label-caps" style={{ marginTop: 'var(--spacing-2)' }}>{t('data.panel.erasure')}</span>
      {data.erasure.length === 0 ? (
        <span className="label-sm">{t('data.panel.noErasure')}</span>
      ) : (
        data.erasure.map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip size="sm" tone={erasureTone(r.status)}>{t(`data.erasureStatus.${r.status}`)}</Chip>
            <span className="label-sm">
              {r.completedAt
                ? t('data.panel.completed', { date: fmt.date(r.completedAt) })
                : t('data.panel.effective', { date: fmt.date(r.effectiveAt) })}
            </span>
          </div>
        ))
      )}
      <ExportLines items={data.exports} />
    </div>
  );
}

/** Панель «Данные» карточки организации: архив и окончательное удаление, сроки хранения, заморозки, выгрузки. */
export function WorkspaceLifecyclePanel({ data }: { data: PlatformWorkspaceLifecyclePanelDto }) {
  const t = useTranslations('platform');
  const tl = useTranslations('lifecycle');
  const fmt = useFormatters();
  const label = useDurationLabel();
  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
      <Fact label={t('data.panel.archived')} value={data.archivedAt ? fmt.date(data.archivedAt) : t('data.panel.active')} />
      {data.purgeAt && <Fact label={t('data.panel.purgeAt')} value={fmt.date(data.purgeAt)} />}
      <Fact label={t('data.panel.activeHolds')} value={data.activeHolds > 0 ? <Chip size="sm" tone="waiting" icon="lock">{fmt.number(data.activeHolds)}</Chip> : fmt.number(0)} />
      {data.erasure && (
        <Fact label={t('data.panel.erasure')} value={<Chip size="sm" tone={erasureTone(data.erasure.status)}>{t(`data.erasureStatus.${data.erasure.status}`)}</Chip>} />
      )}
      <span className="label-caps" style={{ marginTop: 'var(--spacing-2)' }}>{t('data.panel.settings')}</span>
      {data.settings.length === 0 ? (
        <span className="label-sm">{t('data.panel.defaults')}</span>
      ) : (
        data.settings.map((s) => (
          <div key={s.dataClass} className="ui-stack" style={{ gap: 2 }}>
            <Fact label={tl(`classes.${s.dataClass}.title`)} value={label(s.days)} />
            {s.pending && (
              <span className="label-sm" style={{ textAlign: 'right' }}>
                {t('data.panel.pending', { duration: label(s.pending.days), date: fmt.date(s.pending.effectiveAt) })}
              </span>
            )}
          </div>
        ))
      )}
      <ExportLines items={data.exports} />
    </div>
  );
}
