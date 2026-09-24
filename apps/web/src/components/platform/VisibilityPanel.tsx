'use client';

// ============================================================
// Кабинет платформы: панель `workspace.visibility` карточки 360 организации (core/visibility,
// §5.10 D) — версии опубликованных политик по типам записей, черновики, число правил,
// настройки политики, раскрытия данных сотрудников и тревоги массового раскрытия за 30 дней.
// Только сводка: значений полей и состава правил панель не несёт.
// ============================================================

import { useTranslations } from 'next-intl';
import type { PlatformWorkspaceVisibilityPanelDto } from '@superapp/shared';
import { Chip, Table, TableCell, TableHeader, TableRow } from '@/components/ui';
import { useFormatters } from '@/lib/format';

export function WorkspaceVisibilityPanel({ data }: { data: PlatformWorkspaceVisibilityPanelDto }) {
  const t = useTranslations('visibility');
  const f = useFormatters();
  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
        <Chip size="sm" tone="neutral">{t('org.versions.rules', { n: data.rulesTotal })}</Chip>
        <Chip size="sm" tone={data.reveals30d ? 'accent' : 'neutral'} icon="eye">{`${t('platform.reveals30d')}: ${f.number(data.reveals30d)}`}</Chip>
        <Chip size="sm" tone={data.massRevealDetections30d ? 'danger' : 'neutral'} icon="shieldWarning">{`${t('platform.detections30d')}: ${f.number(data.massRevealDetections30d)}`}</Chip>
        {data.settings.dualControl && <Chip size="sm" tone="success" icon="checks">{t('org.settings.dualControl')}</Chip>}
        {data.settings.allowDelegation && <Chip size="sm" tone="warning">{t('org.settings.allowDelegation')}</Chip>}
      </div>
      {data.policies.length === 0 ? (
        <p className="label-sm" style={{ margin: 0 }}>{t('org.emptyTitle')}</p>
      ) : (
        <Table
          lines
          aria-label={t('org.title')}
          columns={[
            { key: 'type', label: t('org.recordType') },
            { key: 'version', label: t('org.versions.title'), width: 'max-content' },
            { key: 'rules', label: '', width: 'max-content' },
            { key: 'at', label: '', width: 'max-content', hideOnMobile: true },
          ]}
        >
          <TableHeader />
          {data.policies.map((p) => (
            <TableRow key={p.recordType}>
              <TableCell>{t(`types.${p.recordType}.title`)}</TableCell>
              <TableCell>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {p.version ? t('org.versions.version', { version: p.version }) : '—'}
                  {p.hasDraft && <Chip size="sm" tone="waiting">{t('org.draft.chip')}</Chip>}
                </span>
              </TableCell>
              <TableCell>{t('org.versions.rules', { n: p.ruleCount })}</TableCell>
              <TableCell hideOnMobile>{p.publishedAt ? f.dateTime(p.publishedAt) : '—'}</TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );
}
