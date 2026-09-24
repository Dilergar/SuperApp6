'use client';

// ============================================================
// Матрица правил видимости организации (§5.10 B.2): строки — группы полей типа (свёрнуты;
// разворачиваются до полей — поле = исключение из группы), столбцы — роли, относительные
// адресаты и добавленные отделы/должности/объекты (замок тарифа). Ячейка — чип уровня;
// клик — поповер: уровень, маска (только допустимые виду), «Может раскрыть по одной записи»,
// «Запрет (сильнее всего)», «Как по умолчанию». Ячейки, которые менять нельзя (пол,
// обязательная видимость, секрет, потолок класса) — приглушены с подсказкой «почему».
// На телефоне — режим «список»: адресат выбирается сверху, ниже группы со своим уровнем.
// ============================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type {
  VisibilityAudienceRef,
  VisibilityFieldGroup,
  VisibilityFieldMetaDto,
  VisibilityLevel,
  VisibilityMaskKind,
  VisibilityRuleDto,
  VisibilityRuleInput,
  VisibilityTypeMetaDto,
} from '@superapp/shared';
import {
  Button,
  Chip,
  Select,
  SegmentedControl,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Toggle,
  Tooltip,
  usePopover,
  type IconName,
  type TableColumn,
  type Tone,
} from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { EntitlementLock } from '@/components/entitlements';
import { loadEntities } from '@/lib/entities';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import {
  applyCellChoice,
  audienceKey,
  fieldCell,
  groupCell,
  groupsOf,
  matrixColumns,
  toInput,
  type CellChoice,
  type CellView,
  type MatrixColumn,
  type MatrixTarget,
} from './matrix-lib';

const LEVEL_TONE: Record<CellView['level'], { tone: Tone; icon?: IconName }> = {
  full: { tone: 'success', icon: 'eye' },
  masked: { tone: 'accent', icon: 'eyeOff' },
  hidden: { tone: 'neutral', icon: 'lock' },
  deny: { tone: 'neutral', icon: 'blocked' },
};

export function LevelChip({ cell, dim }: { cell: Pick<CellView, 'level' | 'reveal'>; dim?: boolean }) {
  const t = useTranslations('visibility');
  const v = LEVEL_TONE[cell.level];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: dim ? 0.62 : 1 }}>
      <Chip size="sm" tone={v.tone} icon={v.icon}>{t(`levels.${cell.level}`)}</Chip>
    </span>
  );
}

/**
 * Подписи столбцов. Отдел / должность / объект, которых уже нет в справочнике организации
 * (удалены после публикации правила), — «устарел» (R3): рантайм такое правило не применяет
 * (у адресата нет принципалов), а матрица предлагает убрать его правила из черновика.
 */
function useColumnLabel(workspaceId: string, columns: MatrixColumn[]): { label: (c: MatrixColumn) => string; isStale: (c: MatrixColumn) => boolean } {
  const t = useTranslations('visibility');
  const tc = useTranslations('common');
  // Имена по видам справочника, которые уже загружены: «устарел» — только среди них
  const [dir, setDir] = useState<{ names: Record<string, string>; kinds: ReadonlySet<string> }>(() => ({ names: {}, kinds: new Set() }));
  const orgKinds = [...new Set(columns.filter((c) => c.kind === 'org').map((c) => c.audience.kind))];
  const orgKey = orgKinds.join(',');
  useEffect(() => {
    if (!orgKinds.length) return;
    let alive = true;
    Promise.all(orgKinds.map((k) => loadEntities(k, { workspaceId })))
      .then((lists) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const list of lists) for (const o of list) map[`${o.type}:${o.id}`] = o.title;
        setDir({ names: map, kinds: new Set(orgKinds) });
      })
      // Справочник не загрузился — «устаревшим» ничего не объявляем (не пугаем зря)
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgKey, workspaceId]);
  const isStale = (c: MatrixColumn) => c.kind === 'org' && dir.kinds.has(c.audience.kind) && !dir.names[audienceKey(c.audience)];
  const label = (c: MatrixColumn) => {
    if (c.kind === 'role') return tc(`role.workspace.${c.audience.id}`);
    if (c.kind === 'relative') return t(`audiences.${c.audience.kind}`);
    const name = dir.names[audienceKey(c.audience)];
    if (name) return name;
    return isStale(c) ? `${t(`audiences.${c.audience.kind}`)} · ${t('org.columns.stale')}` : t(`audiences.${c.audience.kind}`);
  };
  return { label, isStale };
}

/** Почему ячейку нельзя менять — подсказка вместо поповера. */
function lockedText(t: ReturnType<typeof useTranslations>, locked: CellView['locked']): string | null {
  if (!locked) return null;
  return t(`org.cell.locked.${locked}`);
}

export function PolicyMatrix({
  workspaceId,
  meta,
  rules,
  canEdit,
  orgAudiences,
  onRulesChange,
}: {
  workspaceId: string;
  meta: VisibilityTypeMetaDto;
  rules: VisibilityRuleDto[];
  canEdit: boolean;
  /** Тариф открывает столбцы оргструктуры */
  orgAudiences: boolean;
  onRulesChange: (next: VisibilityRuleInput[]) => void;
}) {
  const t = useTranslations('visibility');
  const isMobile = useIsMobile();
  const [extra, setExtra] = useState<VisibilityAudienceRef[]>([]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const columns = useMemo(() => matrixColumns(meta, rules, extra), [meta, rules, extra]);
  const { label, isStale } = useColumnLabel(workspaceId, columns);
  const groups = useMemo(() => groupsOf(meta), [meta]);
  const staleCols = columns.filter(isStale);
  const [mobileCol, setMobileCol] = useState<string>(columns[0]?.key ?? '');

  const change = (target: MatrixTarget, col: MatrixColumn, choice: CellChoice | null) => onRulesChange(applyCellChoice(rules, target, col, choice));
  const toggle = (g: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    return next;
  });

  // Убрать устаревший столбец = снять все его правила из черновика (и из добавленных вручную)
  const removeColumn = (col: MatrixColumn) => {
    setExtra((prev) => prev.filter((a) => audienceKey(a) !== col.key));
    onRulesChange(rules.filter((r) => audienceKey(r.audience) !== col.key).map(toInput));
  };
  const staleBar = staleCols.length > 0 && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
      {staleCols.map((c) => (
        <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-1)' }}>
          <Chip size="sm" tone="warning" icon="warning">{label(c)}</Chip>
          {canEdit && (
            <Button variant="ghost" size="sm" icon="close" onClick={() => removeColumn(c)}>
              {t('org.columns.remove')}
            </Button>
          )}
        </span>
      ))}
    </div>
  );

  const addColumn = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
      {orgAudiences ? (
        <div style={{ minWidth: 240, flex: '0 1 360px' }}>
          <EntitySelector
            types={['department', 'position', 'branch']}
            multi={false}
            context={{ workspaceId }}
            placeholder={t('org.columns.add')}
            value={[]}
            onChange={(next) => {
              const p = next[0];
              if (!p) return;
              const a: VisibilityAudienceRef = { kind: p.type as VisibilityAudienceRef['kind'], id: p.id };
              setExtra((prev) => (prev.some((x) => audienceKey(x) === audienceKey(a)) ? prev : [...prev, a]));
            }}
          />
        </div>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
          <span className="label-sm">{t('org.columns.add')}</span>
          <EntitlementLock keyName="visibility.orgAudiences" workspaceId={workspaceId} />
        </span>
      )}
    </div>
  );

  // ---- Мобильный режим: адресат сверху, ниже группы/поля со своим уровнем ----
  if (isMobile) {
    const col = columns.find((c) => c.key === mobileCol) ?? columns[0];
    if (!col) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
        <Select
          label={t('org.mobileAudience')}
          value={col.key}
          onChange={setMobileCol}
          options={columns.map((c) => ({ value: c.key, label: label(c) }))}
        />
        {canEdit && addColumn}
        {staleBar}
        {groups.map((g) => {
          const gc = groupCell(meta, g, rules, col);
          const fields = meta.fields.filter((f) => f.group === g && f.configurable);
          const expanded = open.has(g);
          return (
            <div key={g} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <Button variant="ghost" size="sm" iconRight={expanded ? 'caretUp' : 'caretDown'} aria-expanded={expanded} onClick={() => toggle(g)}>
                  {t(`groups.${g}`)}
                </Button>
                <CellButton cell={gc} canEdit={canEdit} masks={masksOfGroup(meta, g)} onChoose={(c) => change({ kind: 'group', group: g }, col, c)} />
              </div>
              {expanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)' }}>
                  {fields.map((f) => (
                    <FieldLine key={f.key} f={f} meta={meta}>
                      <CellButton cell={fieldCell(meta, f, rules, col)} canEdit={canEdit} masks={f.masks} onChoose={(c) => change({ kind: 'field', field: f.key }, col, c)} />
                    </FieldLine>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const tableCols: TableColumn[] = [
    { key: 'field', label: t('org.columns.field'), width: 'minmax(12rem, 16rem)' },
    ...columns.map((c) => ({ key: c.key, label: label(c), width: 'max-content' })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
      {canEdit && addColumn}
      {staleBar}
      <div style={{ overflowX: 'auto' }} className="density-compact">
        <Table lines columns={tableCols} aria-label={t(`types.${meta.recordType}.title`)}>
          <TableHeader />
          {groups.map((g) => {
            const fields = meta.fields.filter((f) => f.group === g && f.configurable);
            const expanded = open.has(g);
            return (
              <GroupBlock key={g}>
                <TableRow>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={expanded ? 'caretDown' : 'caretRight'}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? t('org.collapse') : t('org.expand')}: ${t(`groups.${g}`)}`}
                      onClick={() => toggle(g)}
                      style={{ fontWeight: 600 }}
                    >
                      {t(`groups.${g}`)}
                    </Button>
                  </TableCell>
                  {columns.map((c) => (
                    <TableCell key={c.key}>
                      <CellButton cell={groupCell(meta, g, rules, c)} canEdit={canEdit} masks={masksOfGroup(meta, g)} onChoose={(ch) => change({ kind: 'group', group: g }, c, ch)} />
                    </TableCell>
                  ))}
                </TableRow>
                {expanded &&
                  fields.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell>
                        <FieldLine f={f} meta={meta} />
                      </TableCell>
                      {columns.map((c) => {
                        const cell = fieldCell(meta, f, rules, c);
                        return (
                          <TableCell key={c.key}>
                            <CellButton cell={cell} canEdit={canEdit} masks={f.masks} onChoose={(ch) => change({ kind: 'field', field: f.key }, c, ch)} />
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
              </GroupBlock>
            );
          })}
        </Table>
      </div>
    </div>
  );
}

function GroupBlock({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function masksOfGroup(meta: VisibilityTypeMetaDto, g: VisibilityFieldGroup): VisibilityMaskKind[] {
  // Маска группы — только общая для всех её полей (иначе маскировать группу нечем)
  const lists = meta.fields.filter((f) => f.group === g && f.configurable).map((f) => f.masks);
  if (!lists.length) return [];
  return lists[0]!.filter((m) => lists.every((l) => l.includes(m)));
}

function FieldLine({ f, meta, children }: { f: VisibilityFieldMetaDto; meta: VisibilityTypeMetaDto; children?: ReactNode }) {
  const t = useTranslations('visibility');
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
        <span>{t(`types.${meta.recordType}.fields.${f.key}.label`)}</span>
        <span className="label-sm" style={{ opacity: 0.6 }}>{t(`classes.${f.class}`)}</span>
      </span>
      {children}
    </span>
  );
}

/** Чип ячейки + поповер правки (или подсказка «почему нельзя»). */
function CellButton({
  cell,
  canEdit,
  masks,
  onChoose,
}: {
  cell: CellView & { mixed?: boolean };
  canEdit: boolean;
  masks: VisibilityMaskKind[];
  onChoose: (c: CellChoice | null) => void;
}) {
  const t = useTranslations('visibility');
  const pop = usePopover<HTMLButtonElement>({ maxHeight: 360 });
  const why = lockedText(t, cell.locked);
  const fixed = cell.locked === 'floor' || cell.locked === 'mandatory' || cell.locked === 'fixed';
  const chip = <LevelChip cell={cell} dim={cell.source !== 'rule'} />;
  if (!canEdit || fixed) {
    return why ? (
      <Tooltip content={why}>
        <span tabIndex={0} style={{ display: 'inline-flex' }}>{chip}</span>
      </Tooltip>
    ) : (
      chip
    );
  }
  return (
    <>
      <button
        ref={pop.anchorRef}
        type="button"
        onClick={() => pop.setOpen((o) => !o)}
        aria-expanded={pop.open}
        aria-haspopup="dialog"
        title={why ?? undefined}
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        {chip}
        {cell.mixed && <span className="label-sm" style={{ opacity: 0.6 }}>*</span>}
        {cell.source === 'rule' && <span className="label-sm" style={{ opacity: 0.6 }}>•</span>}
      </button>
      {pop.open &&
        createPortal(
          <div ref={pop.layerRef} role="dialog" aria-label={t('org.cell.level')} className="ui-popover" style={{ ...pop.layerStyle, overflowY: 'auto', padding: 'var(--spacing-3)', minWidth: 280 }}>
            <CellEditor
              cell={cell}
              masks={masks}
              onChoose={(c) => {
                pop.setOpen(false);
                onChoose(c);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

function CellEditor({ cell, masks, onChoose }: { cell: CellView; masks: VisibilityMaskKind[]; onChoose: (c: CellChoice | null) => void }) {
  const t = useTranslations('visibility');
  const ceiling = cell.locked === 'ceiling' || cell.locked === 'secret';
  const levels: VisibilityLevel[] = ceiling ? ['masked', 'hidden'] : ['full', 'masked', 'hidden'];
  const [level, setLevel] = useState<VisibilityLevel>(cell.level === 'deny' ? 'hidden' : cell.level);
  const [mask, setMask] = useState<VisibilityMaskKind | null>(cell.mask ?? masks[0] ?? null);
  const [reveal, setReveal] = useState(cell.reveal);
  const [deny, setDeny] = useState(cell.level === 'deny');
  const maskable = masks.filter((m) => m !== 'hidden');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
      {ceiling && <p className="label-sm" style={{ margin: 0 }}>{t(`org.cell.locked.${cell.locked}`)}</p>}
      <SegmentedControl<VisibilityLevel>
        aria-label={t('org.cell.level')}
        value={level}
        onChange={(v) => { setLevel(v); setDeny(false); }}
        items={levels.filter((l) => l !== 'masked' || maskable.length > 0).map((l) => ({ key: l, label: t(`levels.${l}`) }))}
      />
      {level === 'masked' && maskable.length > 0 && (
        <Select
          label={t('org.cell.mask')}
          value={mask ?? maskable[0]!}
          onChange={(v) => setMask(v as VisibilityMaskKind)}
          options={maskable.map((m) => ({ value: m, label: t(`masks.${m}`) }))}
        />
      )}
      {level === 'masked' && cell.locked !== 'secret' && (
        <Toggle checked={reveal} onChange={setReveal} label={t('org.cell.reveal')} />
      )}
      <Toggle checked={deny} onChange={setDeny} label={t('org.cell.deny')} />
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" icon="undo" onClick={() => onChoose(null)}>{t('org.cell.useDefault')}</Button>
        <Button variant="primary" size="sm" onClick={() => onChoose({ level, deny, mask: level === 'masked' ? mask : null, reveal })}>
          {t('org.cell.apply')}
        </Button>
      </div>
    </div>
  );
}
