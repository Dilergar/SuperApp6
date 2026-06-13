'use client';

import { WORKSPACE_ROLES, type Workspace, type WorkspaceRole } from '@superapp/shared';

// Единый источник лейблов ролей — shared (Стажёр/Подрядчик уже включены).
const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  (Object.keys(WORKSPACE_ROLES) as WorkspaceRole[]).map((k) => [k, WORKSPACE_ROLES[k].name]),
);

/**
 * Company card — the org analog of PersonCard (sketch aesthetic). Renders whatever
 * optional fields are present; the backend already nulls fields hidden by the org's
 * card visibility for non-manager viewers, so this naturally shows the right subset.
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
  if (compact) {
    const meta = [
      ws.myRole ? ROLE_LABELS[ws.myRole] ?? ws.myRole : null,
      ws.industry,
      ws.city,
    ].filter(Boolean) as string[];
    return (
      <div>
        <div
          style={{
            width: '2.5rem',
            height: '2.5rem',
            borderRadius: 'var(--radius-sketch)',
            marginBottom: 'var(--spacing-4)',
            background: ws.logo ? `center/cover no-repeat url(${ws.logo})` : 'var(--tertiary-container)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.2rem',
            opacity: ws.logo ? 1 : 0.75,
          }}
        >
          {!ws.logo && '🏢'}
        </div>
        <div className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>{ws.name}</div>
        <p className="label-md" style={{ fontSize: '0.82rem' }}>
          {meta.length > 0 ? `${meta.join(' · ')} · ` : ''}{ws.membersCount} чел.
        </p>
      </div>
    );
  }

  const fields: [string, string][] = (
    [
      ['Отрасль', ws.industry],
      ['Город', ws.city],
      ['Сайт', ws.website],
      ['Email', ws.contactEmail],
      ['Телефон', ws.contactPhone],
    ] as [string, string | null][]
  ).filter((f): f is [string, string] => !!f[1]);

  return (
    <div
      style={{
        background: 'var(--surface-container-lowest)',
        borderRadius: 'var(--radius-sketch)',
        padding: 'var(--spacing-6)',
        boxShadow: '0 8px 32px rgba(198, 26, 30, 0.06)',
        maxWidth: '520px',
        transform: 'rotate(-0.4deg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
        <div
          style={{
            width: '3.5rem',
            height: '3.5rem',
            flexShrink: 0,
            borderRadius: 'var(--radius-sketch)',
            background: ws.logo ? `center/cover no-repeat url(${ws.logo})` : 'var(--tertiary-container)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.6rem',
          }}
        >
          {!ws.logo && '🏢'}
        </div>
        <div>
          <div className="title-lg" style={{ fontSize: '1.4rem' }}>{ws.name}</div>
          {ws.myRole && (
            <span className="label-sm" style={{ color: 'var(--secondary)', fontWeight: 600 }}>
              {ROLE_LABELS[ws.myRole] ?? ws.myRole}
            </span>
          )}
        </div>
      </div>

      {ws.description && (
        <p className="label-md" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.5 }}>
          {ws.description}
        </p>
      )}

      {(fields.length > 0 || showMembers) && (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          {fields.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)' }}>
              <span className="label-sm" style={{ opacity: 0.6 }}>{label}</span>
              <span className="label-md" style={{ fontSize: '0.88rem', textAlign: 'right' }}>{value}</span>
            </div>
          ))}
          {showMembers && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)' }}>
              <span className="label-sm" style={{ opacity: 0.6 }}>Сотрудников</span>
              <span className="label-md" style={{ fontSize: '0.88rem' }}>{ws.membersCount}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
