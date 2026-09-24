// ============================================================
// Матрица «Видимость данных» (core/visibility, §5.10 B) — чистая логика без React.
//
// Ячейка = (цель, адресат). Цель — ГРУППА полей типа (строка-группа) или ПОЛЕ (исключение
// из группы). Уровень ячейки на экране — самое точное правило (поле > группа > секция) этого
// адресата, иначе умолчание платформы из паспорта поля. Истину «кто что видит» с потолками и
// относительными адресатами считает сервер (`explain`); матрица показывает НАСТРОЙКУ.
// ============================================================

import {
  VISIBILITY_MATRIX_ROLE_COLUMNS,
  type VisibilityAudienceRef,
  type VisibilityFieldGroup,
  type VisibilityFieldMetaDto,
  type VisibilityLevel,
  type VisibilityMaskKind,
  type VisibilityRuleDto,
  type VisibilityRuleInput,
  type VisibilityTypeMetaDto,
  type WorkspaceRole,
} from '@superapp/shared';

export type RelativeKind = 'manager_of' | 'branch_head_of' | 'branch_payroll' | 'branch_scheduler';
export const RELATIVE_COLUMNS: readonly RelativeKind[] = ['manager_of', 'branch_head_of', 'branch_payroll', 'branch_scheduler'];

/** Столбец матрицы: роль, относительный адресат или адресат оргструктуры (отдел/должность/объект). */
export interface MatrixColumn {
  key: string;
  audience: VisibilityAudienceRef;
  kind: 'role' | 'relative' | 'org';
}

/** Цель ячейки: группа полей типа или одно поле. */
export type MatrixTarget = { kind: 'group'; group: VisibilityFieldGroup } | { kind: 'field'; field: string };

/** Что показывает ячейка. `rule` — есть ли своё правило (иначе — умолчание/наследование). */
export interface CellView {
  level: VisibilityLevel | 'deny';
  mask: VisibilityMaskKind | null;
  reveal: boolean;
  source: 'rule' | 'group' | 'section' | 'default';
  locked: VisibilityFieldMetaDto['locked'] | 'ceiling' | null;
}

export const audienceKey = (a: VisibilityAudienceRef) => `${a.kind}:${a.id ?? ''}`;

/** Столбцы: роли (кроме владельца — он видит своё по умолчанию, но правило ему можно задать) + относительные + org-адресаты из правил. */
export function matrixColumns(meta: VisibilityTypeMetaDto, rules: readonly VisibilityRuleDto[], extra: readonly VisibilityAudienceRef[]): MatrixColumn[] {
  const cols: MatrixColumn[] = VISIBILITY_MATRIX_ROLE_COLUMNS.map((r) => ({ key: `role:${r}`, audience: { kind: 'role', id: r }, kind: 'role' as const }));
  for (const k of RELATIVE_COLUMNS) {
    if (k === 'manager_of' && meta.subject !== 'user') continue;
    const used = meta.fields.some((f) => f.relativeDefaults[k] !== undefined) || rules.some((r) => r.audience.kind === k);
    if (used) cols.push({ key: `${k}:`, audience: { kind: k, id: null }, kind: 'relative' });
  }
  const seen = new Set(cols.map((c) => c.key));
  for (const a of [...rules.map((r) => r.audience), ...extra]) {
    if (a.kind !== 'department' && a.kind !== 'position' && a.kind !== 'branch') continue;
    const key = audienceKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    cols.push({ key, audience: a, kind: 'org' });
  }
  return cols;
}

const sameAudience = (a: VisibilityAudienceRef, b: VisibilityAudienceRef) => a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

function ruleFor(rules: readonly VisibilityRuleDto[], col: MatrixColumn, target: { field?: string; group?: string; section?: string }): VisibilityRuleDto | null {
  return (
    rules.find((r) => sameAudience(r.audience, col.audience) && !r.stage && target.field !== undefined && r.fieldKey === target.field) ??
    rules.find((r) => sameAudience(r.audience, col.audience) && !r.stage && target.group !== undefined && r.groupKey === target.group && !r.fieldKey) ??
    rules.find((r) => sameAudience(r.audience, col.audience) && !r.stage && target.section !== undefined && r.sectionKey === target.section && !r.fieldKey && !r.groupKey) ??
    null
  );
}

/** Умолчание платформы для поля и столбца. */
function defaultLevel(f: VisibilityFieldMetaDto, col: MatrixColumn): VisibilityLevel {
  if (col.kind === 'role') return f.defaults[col.audience.id as WorkspaceRole] ?? 'hidden';
  if (col.kind === 'relative') return f.relativeDefaults[col.audience.kind as RelativeKind] ?? 'hidden';
  return 'hidden';
}

/** Потолок класса: строгое — не выше маски (полное — только раскрытием), секрет — маска без раскрытия. */
function ceilingOf(f: VisibilityFieldMetaDto): VisibilityLevel | null {
  if (f.class === 'restricted' || f.class === 'secret') return 'masked';
  return null;
}

export function fieldCell(meta: VisibilityTypeMetaDto, f: VisibilityFieldMetaDto, rules: readonly VisibilityRuleDto[], col: MatrixColumn): CellView {
  const own = rules.find((r) => sameAudience(r.audience, col.audience) && !r.stage && r.fieldKey === f.key) ?? null;
  const inherited = own ?? ruleFor(rules, col, { group: f.group, section: f.section });
  const locked = f.locked ?? null;
  let level: CellView['level'];
  let mask: VisibilityMaskKind | null = null;
  let reveal = false;
  let source: CellView['source'] = 'default';
  if (inherited) {
    level = inherited.effect === 'deny' ? 'deny' : inherited.level;
    mask = inherited.mask;
    reveal = inherited.reveal !== 'none';
    source = own ? 'rule' : inherited.groupKey ? 'group' : 'section';
  } else {
    level = defaultLevel(f, col);
    reveal = col.kind === 'role' && f.revealDefault.includes(col.audience.id as WorkspaceRole);
  }
  const ceiling = ceilingOf(f);
  if (ceiling && level === 'full') return { level: 'masked', mask: mask ?? f.masks[0] ?? null, reveal: f.class !== 'secret' && reveal, source, locked: locked ?? 'ceiling' };
  if (f.class === 'secret') reveal = false;
  return { level, mask: level === 'masked' ? (mask ?? f.masks[0] ?? null) : null, reveal, source, locked };
}

/** Ячейка группы: своё правило группы, иначе «как у полей» (самый частый уровень умолчаний). */
export function groupCell(meta: VisibilityTypeMetaDto, group: VisibilityFieldGroup, rules: readonly VisibilityRuleDto[], col: MatrixColumn): CellView & { mixed: boolean } {
  const fields = meta.fields.filter((f) => f.group === group && f.configurable);
  const own = rules.find((r) => sameAudience(r.audience, col.audience) && !r.stage && r.groupKey === group && !r.fieldKey) ?? null;
  if (own) return { level: own.effect === 'deny' ? 'deny' : own.level, mask: own.mask, reveal: own.reveal !== 'none', source: 'rule', locked: null, mixed: false };
  const cells = fields.map((f) => fieldCell(meta, f, rules, col));
  const levels = [...new Set(cells.map((c) => c.level))];
  const first = cells[0];
  return {
    level: first?.level ?? 'hidden',
    mask: first?.mask ?? null,
    reveal: first?.reveal ?? false,
    source: 'default',
    locked: fields.length === 0 ? 'fixed' : null,
    mixed: levels.length > 1,
  };
}

/** Правило из выбора в поповере; `null` — «как по умолчанию» (правило снимается). */
export interface CellChoice {
  level: VisibilityLevel;
  deny: boolean;
  mask: VisibilityMaskKind | null;
  reveal: boolean;
}

/** Новые правила после правки одной ячейки (ровно одно правило на цель × адресата). */
export function applyCellChoice(rules: readonly VisibilityRuleDto[], target: MatrixTarget, col: MatrixColumn, choice: CellChoice | null): VisibilityRuleInput[] {
  const matches = (r: VisibilityRuleDto) =>
    sameAudience(r.audience, col.audience) &&
    !r.stage &&
    (target.kind === 'field' ? r.fieldKey === target.field : r.groupKey === target.group && !r.fieldKey);
  const kept = rules.filter((r) => !matches(r)).map(toInput);
  if (!choice) return kept;
  const next: VisibilityRuleInput = {
    fieldKey: target.kind === 'field' ? target.field : null,
    groupKey: target.kind === 'group' ? target.group : null,
    sectionKey: null,
    audience: col.audience as VisibilityRuleInput['audience'],
    effect: choice.deny ? 'deny' : 'allow',
    level: choice.deny ? 'hidden' : choice.level,
    mask: !choice.deny && choice.level === 'masked' ? choice.mask : null,
    reveal: !choice.deny && choice.level === 'masked' && choice.reveal ? 'one' : 'none',
  };
  return [...kept, next];
}

export function toInput(r: VisibilityRuleDto): VisibilityRuleInput {
  return {
    fieldKey: r.fieldKey,
    groupKey: r.groupKey,
    sectionKey: r.sectionKey,
    audience: r.audience as VisibilityRuleInput['audience'],
    effect: r.effect,
    level: r.level,
    mask: r.mask,
    reveal: r.reveal,
    stage: r.stage,
    ...(r.surfaces ? { surfaces: r.surfaces } : {}),
  };
}

/** Группы типа по порядку реестра (строки-группы матрицы), только с настраиваемыми полями. */
export function groupsOf(meta: VisibilityTypeMetaDto): VisibilityFieldGroup[] {
  const out: VisibilityFieldGroup[] = [];
  for (const f of meta.fields) if (f.configurable && !out.includes(f.group)) out.push(f.group);
  return out;
}
