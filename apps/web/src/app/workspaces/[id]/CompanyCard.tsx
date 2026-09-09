'use client';

import { useTranslations } from 'next-intl';
import { Chip, Divider, Icon } from '@/components/ui';
import type { Workspace } from '@superapp/shared';

// Имя ступени пропуска — из каталога (`common.role.workspace.<role>`): реестр
// `WORKSPACE_ROLES` несёт права, а не слова.

/** Логотип организации или запасная иконка в матовом квадрате. */
function CompanyLogo({ logo, size }: { logo?: string | null; size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: 'var(--radius-md)',
        background: logo ? `center/cover no-repeat url(${logo})` : 'var(--surface-container)',
        border: logo ? 'none' : '1px solid var(--border)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--muted)',
      }}
    >
      {!logo && <Icon name="workspace" size={Math.round(size * 0.5)} />}
    </span>
  );
}

/**
 * Company card — the org analog of PersonCard. Renders whatever optional fields are
 * present; the backend already nulls fields hidden by the org's card visibility for
 * non-manager viewers, so this naturally shows the right subset.
 */
export function CompanyCard({
  ws,
  showMembers = true,
  compact = false,
}: {
  ws: Pick<
    Workspace,
    | 'name'
    | 'logo'
    | 'description'
    | 'industry'
    | 'city'
    | 'website'
    | 'contactEmail'
    | 'contactPhone'
    | 'membersCount'
    | 'myRole'
  >;
  showMembers?: boolean;
  /** Compact tile for the "Организации" grid (logo + name + meta line). */
  compact?: boolean;
}) {
  const t = useTranslations('workspaces');
  const tc = useTranslations('common');
  const roleChip = ws.myRole ? (
    <Chip size="sm" tone="accent" icon="user">{tc(`role.workspace.${ws.myRole}`)}</Chip>
  ) : null;

  if (compact) {
    const meta = [ws.industry, ws.city].filter(Boolean) as string[];
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-2)' }}>
          <CompanyLogo logo={ws.logo} size={40} />
          <span style={{ minWidth: 0 }}>
            <span className="title-sm" style={{ display: 'block' }}>{ws.name}</span>
            <span className="label-sm">
              {meta.length > 0 ? `${meta.join(' · ')} · ` : ''}{t('card.membersShort', { n: ws.membersCount })}
            </span>
          </span>
        </div>
        {roleChip}
      </div>
    );
  }

  const fields: [string, string][] = (
    [
      [t('card.industry'), ws.industry],
      [t('card.city'), ws.city],
      [t('card.website'), ws.website],
      [t('card.email'), ws.contactEmail],
      [t('card.phone'), ws.contactPhone],
    ] as [string, string | null][]
  ).filter((f): f is [string, string] => !!f[1]);

  return (
    <div
      style={{
        background: 'var(--block)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        padding: 'var(--spacing-6)',
        boxShadow: 'var(--shadow-card)',
        maxWidth: 520,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)' }}>
        <CompanyLogo logo={ws.logo} size={56} />
        <div style={{ minWidth: 0 }}>
          <div className="title-md">{ws.name}</div>
          {roleChip && <div style={{ marginTop: '0.25rem' }}>{roleChip}</div>}
        </div>
      </div>

      {ws.description && (
        <p className="body-md" style={{ margin: 'var(--spacing-4) 0 0' }}>{ws.description}</p>
      )}

      {(fields.length > 0 || showMembers) && (
        <>
          <Divider />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            {fields.map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)' }}>
                <span className="label-caps">{label}</span>
                <span className="body-sm" style={{ textAlign: 'right' }}>{value}</span>
              </div>
            ))}
            {showMembers && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)' }}>
                <span className="label-caps">{t('card.members')}</span>
                <span className="body-sm">{ws.membersCount}</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
