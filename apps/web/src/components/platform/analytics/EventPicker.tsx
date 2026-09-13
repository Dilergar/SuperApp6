'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ANALYTICS_AREA_KEYS, type AnalyticsEventCatalogItemDto } from '@superapp/shared';
import { Button, Chip, Modal, SearchField } from '@/components/ui';
import { useAnalyticsText } from './useAnalyticsText';

/**
 * Выбор события: кнопка с текущим выбором → окно с поиском, группы по сервису,
 * человеческое название и описание из каталога, объём за 7 дней и статус. События без
 * данных помечены и стоят в группе последними — их не предлагают первыми.
 */
export function EventPicker({
  label,
  value,
  onChange,
  events,
  anyLabel,
  exclude,
  addLabel,
}: {
  label: string;
  value: string | null;
  onChange: (key: string | null) => void;
  events: AnalyticsEventCatalogItemDto[];
  /** Разрешить «любое» (null) — подпись этого варианта */
  anyLabel?: string;
  /** Не предлагать эти ключи (уже выбраны рядом — например, в том же шаге воронки) */
  exclude?: string[];
  /** Режим «добавить»: вместо поля с текущим выбором — небольшая кнопка с этой подписью */
  addLabel?: string;
}) {
  const t = useTranslations('analytics');
  const text = useAnalyticsText();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = events.filter(
      (e) => e.status !== 'blocked' && !exclude?.includes(e.key) && (!needle || text.event(e.key).toLowerCase().includes(needle) || e.key.includes(needle)),
    );
    return ANALYTICS_AREA_KEYS.map((area) => ({
      area,
      items: matches.filter((e) => e.service === area).sort((a, b) => (b.volume7d > 0 ? 1 : 0) - (a.volume7d > 0 ? 1 : 0)),
    })).filter((g) => g.items.length > 0);
  }, [events, search, text, exclude]);

  return (
    <div className={addLabel ? undefined : 'ui-stack'} style={addLabel ? undefined : { gap: '0.25rem' }}>
      {addLabel ? (
        <Button size="sm" variant="ghost" icon="add" onClick={() => setOpen(true)}>
          {addLabel}
        </Button>
      ) : (
        <>
          <span className="label-caps">{label}</span>
          <Button variant="outline" icon="bolt" onClick={() => setOpen(true)} style={{ justifyContent: 'flex-start', width: '100%' }}>
            {value ? text.event(value) : (anyLabel ?? t('builder.pickEvent'))}
          </Button>
        </>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={label} size="lg">
        <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
          <SearchField width="100%" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder={t('builder.findEvent')} aria-label={t('builder.findEvent')} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)', maxHeight: '60vh', overflowY: 'auto' }}>
            {anyLabel && (
              <Button variant={value === null ? 'matte' : 'ghost'} icon="spark" onClick={() => { onChange(null); setOpen(false); }} style={{ justifyContent: 'flex-start' }}>
                {anyLabel}
              </Button>
            )}
            {groups.map((g) => (
              <div key={g.area} className="ui-stack" style={{ gap: '0.25rem' }}>
                <span className="label-caps">{text.area(g.area)}</span>
                {g.items.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    onClick={() => {
                      onChange(e.key);
                      setOpen(false);
                    }}
                    aria-pressed={value === e.key}
                    style={{
                      display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.5rem', textAlign: 'start', padding: '0.5rem 0.625rem',
                      borderRadius: 'var(--radius-md)', border: '1px solid var(--divider)', cursor: 'pointer',
                      background: value === e.key ? 'var(--active)' : 'var(--surface-container-lowest)', color: 'inherit', font: 'inherit',
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="body-sm" style={{ fontWeight: 700, display: 'block' }}>{text.event(e.key)}</span>
                      <span className="label-sm" style={{ display: 'block' }}>{text.eventDescription(e.key)}</span>
                    </span>
                    <span style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {e.volume7d > 0 ? (
                        <span className="label-sm">{t('builder.volume7d', { count: e.volume7d })}</span>
                      ) : (
                        <Chip size="sm" tone="neutral">{t('builder.noData')}</Chip>
                      )}
                      {e.status === 'planned' && <Chip size="sm" tone="accent">{t('statuses.planned')}</Chip>}
                      {e.status === 'deprecated' && <Chip size="sm" tone="warning">{t('statuses.deprecated')}</Chip>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
