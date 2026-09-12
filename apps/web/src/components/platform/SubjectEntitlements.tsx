'use client';

import { useTranslations } from 'next-intl';
import { ENTITLEMENT_REGISTRY, type EntitlementKey, type EntitlementSubjectDetailDto, type EntitlementValue, type EntitlementValueDto } from '@superapp/shared';
import { Chip, Table, TableCell, TableRow, TickBar, type Tone } from '@/components/ui';
import { useBytes, useFormatters } from '@/lib/format';

const STATUS_TONE: Record<string, Tone> = { trialing: 'warning', active: 'success', past_due: 'warning', expired: 'danger', cancelled: 'neutral' };

/**
 * Карточка субъекта в кабинете: подписка (план, версия, статус, сроки), гранты и
 * оверрайды таблицами с чипами источника и сроком, счётчики квот, «как видит клиент» —
 * итоговый снимок. Здесь видны reason/grantedBy/createdBy — в продукт они не уезжают.
 */
export function SubjectEntitlements({ detail }: { detail: EntitlementSubjectDetailDto }) {
  const t = useTranslations('platform');
  const te = useTranslations('entitlements');
  const f = useFormatters();
  const bytes = useBytes();
  const sub = detail.subscription;
  const keyLabel = (key: string) => {
    const def = ENTITLEMENT_REGISTRY[key as EntitlementKey];
    return def ? te(def.labelKey.replace(/^entitlements\./, '')) : key;
  };
  /** Значение источника (грант, условие) — теми же словами, что и итоговый снимок: «true» в таблице читать нечем. */
  const rawValueText = (key: string, value: EntitlementValue, isBytes = ENTITLEMENT_REGISTRY[key as EntitlementKey]?.unit === 'bytes'): string => {
    if (value === null) return te('page.unlimited');
    if (typeof value === 'boolean') return value ? te('page.available') : te('page.unavailable');
    return isBytes ? bytes(value) : f.number(value);
  };
  const valueText = (dto: EntitlementValueDto): string => rawValueText(dto.key, dto.value, dto.unit === 'bytes');

  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-5)' }}>
      <section>
        <span className="label-caps">{t('subject.subscription')}</span>
        {sub ? (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.375rem' }}>
            <span className="title-md">{te(`plans.${sub.planKey}`)}</span>
            <Chip tone="neutral" size="sm">v{sub.version}</Chip>
            <Chip tone={STATUS_TONE[sub.status] ?? 'neutral'} size="sm">{t(`subscriptionStatus.${sub.status}`)}</Chip>
            <Chip tone="neutral" size="sm">{t(`subscriptionSource.${sub.source}`)}</Chip>
            {sub.trialEndsAt && <span className="label-sm">{t('subject.trialEndsAt', { date: f.date(sub.trialEndsAt) })}</span>}
            {sub.currentPeriodEnd && <span className="label-sm">{t('subject.periodEnd', { date: f.date(sub.currentPeriodEnd) })}</span>}
            {sub.graceUntil && <span className="label-sm">{t('subject.graceUntil', { date: f.date(sub.graceUntil) })}</span>}
          </div>
        ) : (
          <p className="body-sm" style={{ marginTop: '0.375rem' }}>{te('status.free')}</p>
        )}
      </section>

      <section>
        <span className="label-caps">{t('subject.grants')}</span>
        {detail.grants.length === 0 ? (
          <p className="label-sm" style={{ marginTop: '0.375rem' }}>{t('subject.none')}</p>
        ) : (
          <Table
            columns={[
              { key: 'key', label: t('subject.col.key') },
              { key: 'value', label: t('subject.col.value'), width: 'max-content' },
              { key: 'source', label: t('subject.col.source'), width: 'max-content' },
              { key: 'until', label: t('subject.col.until'), width: 'max-content' },
              { key: 'who', label: t('subject.col.who'), hideOnMobile: true },
            ]}
            lines
            aria-label={t('subject.grants')}
          >
            {detail.grants.map((g, i) => (
              <TableRow key={g.id} rowIndex={i + 1} style={g.revokedAt ? { opacity: 0.5 } : undefined}>
                <TableCell>{keyLabel(g.key)}</TableCell>
                <TableCell>{rawValueText(g.key, g.value)}</TableCell>
                <TableCell><Chip tone="accent" size="sm">{t(`grantSource.${g.source}`)}</Chip></TableCell>
                <TableCell>{g.validUntil ? f.date(g.validUntil) : '—'}{g.revokedAt ? ` · ${t('subject.revoked')}` : ''}</TableCell>
                <TableCell hideOnMobile><span className="label-sm">{g.reason ?? ''}{g.grantedBy ? ` · ${g.grantedBy.slice(0, 8)}` : ''}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      <section>
        <span className="label-caps">{t('subject.overrides')}</span>
        {detail.overrides.length === 0 ? (
          <p className="label-sm" style={{ marginTop: '0.375rem' }}>{t('subject.none')}</p>
        ) : (
          <Table
            columns={[
              { key: 'key', label: t('subject.col.key') },
              { key: 'mode', label: t('subject.col.mode'), width: 'max-content' },
              { key: 'value', label: t('subject.col.value'), width: 'max-content' },
              { key: 'until', label: t('subject.col.until'), width: 'max-content' },
              { key: 'reason', label: t('subject.col.reason'), hideOnMobile: true },
            ]}
            lines
            aria-label={t('subject.overrides')}
          >
            {detail.overrides.map((o, i) => (
              <TableRow key={o.id} rowIndex={i + 1}>
                <TableCell>{keyLabel(o.key)}</TableCell>
                <TableCell><Chip tone="accent" size="sm">{t(`overrideMode.${o.mode}`)}</Chip></TableCell>
                <TableCell>{o.mode === 'set' ? rawValueText(o.key, o.value) : '—'}</TableCell>
                <TableCell>{f.date(o.validUntil)}</TableCell>
                <TableCell hideOnMobile><span className="label-sm">{o.reason} · {o.createdBy.slice(0, 8)}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      {detail.counters.length > 0 && (
        <section>
          <span className="label-caps">{t('subject.counters')}</span>
          <div className="ui-stack" style={{ gap: '0.5rem', marginTop: '0.375rem' }}>
            {detail.counters.map((c) => {
              const dto = detail.snapshot.values[c.key as EntitlementKey];
              const limit = typeof dto?.value === 'number' ? dto.value : null;
              const isBytes = ENTITLEMENT_REGISTRY[c.key as EntitlementKey]?.unit === 'bytes';
              const pct = limit ? Math.min(100, (c.used / limit) * 100) : 0;
              return (
                <div key={c.key} style={{ maxWidth: '28rem' }}>
                  <TickBar
                    value={pct}
                    tone={pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'accent'}
                    label={`${keyLabel(c.key)}: ${isBytes ? bytes(c.used) : f.number(c.used)}${limit !== null ? ` / ${isBytes ? bytes(limit) : f.number(limit)}` : ''}`}
                  />
                  {c.periodEnd && <span className="label-sm">{te('page.resetAt', { date: f.date(c.periodEnd) })}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <span className="label-caps">{t('subject.snapshot')}</span>
        <Table
          columns={[
            { key: 'key', label: t('subject.col.key') },
            { key: 'value', label: t('subject.col.value'), width: 'max-content' },
            { key: 'used', label: t('subject.col.used'), width: 'max-content' },
            { key: 'source', label: t('subject.col.source'), width: 'max-content' },
          ]}
          lines
          aria-label={t('subject.snapshot')}
        >
          {(Object.values(detail.snapshot.values) as EntitlementValueDto[]).map((dto, i) => (
            <TableRow key={dto.key} rowIndex={i + 1}>
              <TableCell>{keyLabel(dto.key)}</TableCell>
              <TableCell>{valueText(dto)}</TableCell>
              <TableCell>{dto.used === null ? '—' : dto.unit === 'bytes' ? bytes(dto.used) : f.number(dto.used)}</TableCell>
              <TableCell>
                <Chip tone={dto.source === 'override' ? 'warning' : dto.source === 'grant' ? 'accent' : 'neutral'} size="sm">
                  {t(`valueSource.${dto.source}`)}{dto.sourceUntil ? ` · ${f.date(dto.sourceUntil)}` : ''}
                </Chip>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </section>
    </div>
  );
}
