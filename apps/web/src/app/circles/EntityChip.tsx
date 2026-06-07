'use client';

import { SIZE_CONFIG, type CardSize } from './card-skin';
import { PersonChip } from './PersonCard';
import type { EntityOption } from '@/lib/entities';

// ============================================================
// Entity chips — the render side of the universal selector.
// One renderer per entity type, dispatched by EntityChip. People reuse
// the skinned PersonChip; groups/departments get GroupChip. Same 5 sizes,
// so an EntitySelector row/chip looks consistent across types.
// ============================================================

/** A group/department/branch chip (no skin) — mirrors PersonChip sizing. */
export function GroupChip({ size, icon, name, color, count }: {
  size: CardSize;
  icon?: string | null;
  name: string;
  color?: string | null;
  count?: number;
}) {
  const cfg = SIZE_CONFIG[size];
  const av = cfg.avatar;
  const square = (
    <div style={{
      width: av, height: av, flexShrink: 0,
      borderRadius: 'var(--radius-sketch)',
      background: color || 'var(--surface-container-high)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(av * 0.5), lineHeight: 1,
    }}>
      {icon || '📁'}
    </div>
  );
  return (
    <div style={{
      display: cfg.layout === 'row' ? 'inline-flex' : 'flex',
      flexDirection: cfg.layout === 'row' ? 'row' : 'column',
      alignItems: 'center', gap: cfg.gap, padding: cfg.padding,
      background: 'var(--surface-container)', borderRadius: 'var(--radius-md)', maxWidth: '100%',
    }}>
      {square}
      {cfg.showName && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: cfg.nameSize, fontWeight: 700,
            letterSpacing: '0.04em', color: 'var(--on-surface)', lineHeight: 1.1,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {name}
          </div>
          {cfg.showRole && count != null && (
            <div style={{ color: 'var(--on-surface-variant)', fontSize: cfg.metaSize }}>{count} участн.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Render any entity option as the right chip for its type. */
export function EntityChip({ entity, size }: { entity: EntityOption; size: CardSize }) {
  if (entity.type === 'user') {
    return (
      <PersonChip
        size={size}
        userId={entity.id}
        firstName={entity.firstName ?? entity.title}
        lastName={entity.lastName ?? null}
        role={entity.role ?? null}
      />
    );
  }
  // circle / department / branch / position → group-style chip
  return <GroupChip size={size} icon={entity.icon} name={entity.title} color={entity.color} count={entity.count} />;
}
