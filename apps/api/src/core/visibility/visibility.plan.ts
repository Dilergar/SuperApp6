import {
  HIDDEN,
  VISIBILITY_BOT_CLASS_CEILING,
  VISIBILITY_BOT_CONTACT_CLASS,
  VISIBILITY_CLASS_CEILING,
  VISIBILITY_CLASS_RANK,
  VISIBILITY_AUDIENCE_KINDS,
  VISIBILITY_FIELD_GROUPS,
  VISIBILITY_EXTERNAL_PURPOSES,
  VISIBILITY_LEVEL_RANK,
  VISIBILITY_LEVELS,
  VISIBILITY_MASK_KINDS,
  VISIBILITY_RULE_REVEAL_MODES,
  applyMask,
  isVisibilityFieldConfigurable,
  isVisibilityRecordType,
  maxVisibilityLevel,
  minVisibilityLevel,
  visibilityFieldDefaults,
  visibilityFieldEntry,
  visibilityFieldsOf,
  type Guarded,
  type Masked,
  type VisibilityAudienceKind,
  type VisibilityFieldCap,
  type VisibilityFieldEntry,
  type VisibilityFieldGroup,
  type VisibilityLevel,
  type VisibilityMaskKind,
  type VisibilityPersonalDefault,
  type VisibilityPurpose,
  type VisibilityRevealMode,
  type VisibilityRuleRevealMode,
  type VisibilityWhyDto,
  type WorkspaceRole,
} from '@superapp/shared';

// ============================================================
// core/visibility — ЧИСТОЕ вычисление решения по полю (чокпойнт D).
// ============================================================
// Никакой БД, Redis и Nest: вход — паспорт поля, скомпилированная политика владельца,
// факты о зрителе и его отношение к записи; выход — уровень, маска, раскрытие, caps и
// «почему». Так инварианты проверяются property-based тестом (`verify-visibility-plan.cjs`),
// а сервис только собирает факты. При ЛЮБОЙ неясности решение — `hidden` (fail-closed).

/** Правило, скомпилированное из строки `visibility_rules` (сироты отброшены при компиляции). */
export interface CompiledRule {
  id: string;
  fieldKey: string | null;
  groupKey: VisibilityFieldGroup | null;
  sectionKey: string | null;
  audienceKind: VisibilityAudienceKind;
  audienceId: string | null;
  effect: 'allow' | 'deny';
  level: VisibilityLevel;
  mask: VisibilityMaskKind | null;
  reveal: VisibilityRuleRevealMode;
  stage: string | null;
}

/** Строка правила в том виде, в каком её читает компиляция. */
export interface RuleRow {
  id: string;
  fieldKey: string | null;
  groupKey: string | null;
  sectionKey: string | null;
  audienceKind: string;
  audienceId: string | null;
  effect: string;
  level: string;
  mask: string | null;
  reveal: string;
  stage: string | null;
}

const RULE_LEVELS = new Set<string>(VISIBILITY_LEVELS);
const RULE_GROUPS = new Set<string>(VISIBILITY_FIELD_GROUPS);
const RULE_AUDIENCES = new Set<string>(VISIBILITY_AUDIENCE_KINDS);
const RULE_MASKS = new Set<string>(VISIBILITY_MASK_KINDS);
const RULE_REVEALS = new Set<string>(VISIBILITY_RULE_REVEAL_MODES);

/**
 * Компиляция строк правил: сироты (поле/группа/секция ушли из реестра) и мусор словарей
 * ОТБРАСЫВАЮТСЯ (рантайм игнорирует сирот — страж `check:visibility` требует миграцию-уборку);
 * у запрета уровень всегда `hidden`.
 */
export function compileRules(recordType: string, rows: readonly RuleRow[]): CompiledRule[] {
  if (!isVisibilityRecordType(recordType)) return [];
  const sections = new Set(visibilityFieldsOf(recordType).map((e) => e.section));
  const out: CompiledRule[] = [];
  for (const r of rows) {
    if (r.fieldKey && !visibilityFieldEntry(recordType, r.fieldKey)) continue;
    if (r.groupKey && !RULE_GROUPS.has(r.groupKey)) continue;
    if (r.sectionKey && !sections.has(r.sectionKey)) continue;
    if (!r.fieldKey && !r.groupKey && !r.sectionKey) continue;
    if (!RULE_LEVELS.has(r.level) || (r.effect !== 'allow' && r.effect !== 'deny')) continue;
    // Неизвестный вид адресата не совпадёт ни с одним столбцом, но в кэше ему не место
    if (!RULE_AUDIENCES.has(r.audienceKind)) continue;
    out.push({
      id: r.id,
      fieldKey: r.fieldKey,
      groupKey: (r.groupKey as VisibilityFieldGroup | null) ?? null,
      sectionKey: r.sectionKey,
      audienceKind: r.audienceKind as VisibilityAudienceKind,
      audienceId: r.audienceId,
      effect: r.effect,
      level: r.effect === 'deny' ? 'hidden' : (r.level as VisibilityLevel),
      // Неизвестная маска — как «без маски» (уровень `masked` тогда возьмёт маску поля или станет `hidden`);
      // неизвестное раскрытие — «нет»: при любой неясности — строже
      mask: r.mask && RULE_MASKS.has(r.mask) ? (r.mask as VisibilityMaskKind) : null,
      reveal: RULE_REVEALS.has(r.reveal) ? (r.reveal as VisibilityRuleRevealMode) : 'none',
      stage: r.stage,
    });
  }
  return out;
}

/** Опубликованная политика владельца по типу; `pv = 0` — политики нет (действуют умолчания). */
export interface CompiledPolicy {
  pv: number;
  rules: readonly CompiledRule[];
}

export const EMPTY_POLICY: CompiledPolicy = Object.freeze({ pv: 0, rules: Object.freeze([]) as readonly CompiledRule[] });

/** Факты о зрителе в «шляпе» запроса (одна организация — одна шляпа). */
export interface ViewerFacts {
  kind: 'user' | 'bot' | 'guest' | 'system';
  userId: string | null;
  /** Роль в организации-владельце политики (служебные поля); вне организации — null */
  role: WorkspaceRole | null;
  /** `department:<id>` / `position:<id>` / `branch:<id>` — принципалы оргструктуры */
  principals: ReadonlySet<string>;
  /** Ключу выдан флаг «Доступ к контактным данным» (R9) */
  botContactAccess: boolean;
  purpose: VisibilityPurpose;
  /** Организация разрешила делегирование раскрытия (настройка ∧ тариф) */
  revealDelegation: boolean;
}

/** Отношение зрителя к ЗАПИСИ служебного типа (вычисляет сервис по провайдерам). */
export interface RowRelation {
  self: boolean;
  /** Зритель — руководитель субъекта записи */
  managerOf: boolean;
  /** Зритель руководит объектом записи (или основным местом субъекта) */
  branchHead: boolean;
  /** У зрителя пообъектный грант «видит деньги» на объект записи */
  branchPayroll: boolean;
  /** Зритель ведёт график объекта записи (руководитель, управляющий, делегат `scheduler`) */
  branchScheduler: boolean;
  stage: string | null;
}

/** Отношение зрителя к СУБЪЕКТУ личного поля. */
export interface PersonalRelation {
  self: boolean;
  /** Связь в Окружении (ContactLink) */
  linked: boolean;
  /** Группы субъекта, в которых состоит зритель */
  circleIds: ReadonlySet<string>;
  /** Организации, где оба — в команде */
  colleagueWorkspaceIds: ReadonlySet<string>;
  /** Взаимность: зритель сам скрывает от субъекта своё присутствие */
  viewerHidesOwnPresence?: boolean;
}

export interface FieldDecision {
  level: VisibilityLevel;
  mask: VisibilityMaskKind | null;
  reveal: VisibilityRevealMode;
  caps: VisibilityFieldCap[];
  why: VisibilityWhyDto;
}

export const HIDDEN_DECISION = (why: VisibilityWhyDto): FieldDecision => ({ level: 'hidden', mask: null, reveal: 'none', caps: [], why });

/** Маска уровня `masked`: маска правила, если поле её допускает, иначе первая маска поля; нет — null. */
export function pickMask(entry: VisibilityFieldEntry, preferred: VisibilityMaskKind | null | undefined): VisibilityMaskKind | null {
  const allowed = (entry.def.masks ?? []).filter((m) => m !== 'hidden');
  if (preferred && preferred !== 'hidden' && allowed.includes(preferred)) return preferred;
  return allowed[0] ?? null;
}

/**
 * Правило относится к полю (поле > группа > секция) и к этапу записи? Возвращает специфичность
 * или -1. Правило, ограниченное этапом, точнее правила «на все этапы» той же цели: «оклад
 * уволенным — скрыть» побеждает «оклад — целиком» на записи уволенного, а не зависит от порядка строк.
 */
function ruleSpecificity(rule: CompiledRule, entry: VisibilityFieldEntry, stage: string | null): number {
  if (rule.stage && rule.stage !== stage) return -1;
  const staged = rule.stage ? 1 : 0;
  if (rule.fieldKey) return rule.fieldKey === entry.key ? 6 + staged : -1;
  if (rule.groupKey) return rule.groupKey === entry.def.group ? 4 + staged : -1;
  if (rule.sectionKey) return rule.sectionKey === entry.section ? 2 + staged : -1;
  return -1;
}

/** Самое специфичное правило политики для столбца-адресата (поле > группа > секция, с этапом > без; при равенстве — первое). */
export function ruleForColumn(
  policy: CompiledPolicy,
  entry: VisibilityFieldEntry,
  kind: VisibilityAudienceKind,
  id: string | null,
  stage: string | null,
): CompiledRule | null {
  let best: CompiledRule | null = null;
  let bestSpec = -1;
  for (const r of policy.rules) {
    if (r.audienceKind !== kind || (r.audienceId ?? null) !== (id ?? null)) continue;
    const spec = ruleSpecificity(r, entry, stage);
    if (spec > bestSpec) {
      best = r;
      bestSpec = spec;
    }
  }
  return best;
}

interface Contribution {
  effect: 'allow' | 'deny';
  level: VisibilityLevel;
  mask: VisibilityMaskKind | null;
  reveal: VisibilityRuleRevealMode;
  why: VisibilityWhyDto;
}

/** Столбцы матрицы, в которые попадает зритель (роль, оргструктура, относительные по записи). */
export function viewerColumns(viewer: ViewerFacts, rel: RowRelation): Array<{ kind: VisibilityAudienceKind; id: string | null }> {
  const cols: Array<{ kind: VisibilityAudienceKind; id: string | null }> = [];
  if (viewer.role) cols.push({ kind: 'role', id: viewer.role });
  for (const p of viewer.principals) {
    const sep = p.indexOf(':');
    const kind = p.slice(0, sep) as VisibilityAudienceKind;
    if (kind === 'department' || kind === 'position' || kind === 'branch') cols.push({ kind, id: p.slice(sep + 1) });
  }
  if (rel.managerOf) cols.push({ kind: 'manager_of', id: null });
  if (rel.branchHead) cols.push({ kind: 'branch_head_of', id: null });
  if (rel.branchPayroll) cols.push({ kind: 'branch_payroll', id: null });
  if (rel.branchScheduler) cols.push({ kind: 'branch_scheduler', id: null });
  return cols;
}

/** Применить потолки: класс поля, бот/ключ, назначение ответа. Самой «шляпы» не касается. */
function applyCeilings(entry: VisibilityFieldEntry, viewer: ViewerFacts, d: FieldDecision, isSelf: boolean): FieldDecision {
  const cls = entry.def.class;
  let out = d;
  // Бот / ключ API (R9): класс ≤ internal; contact — только с флагом ключа; раскрытия нет никогда
  if (viewer.kind === 'bot') {
    const rank = VISIBILITY_CLASS_RANK[cls];
    const allowedContact = cls === VISIBILITY_BOT_CONTACT_CLASS && viewer.botContactAccess;
    if (rank > VISIBILITY_CLASS_RANK[VISIBILITY_BOT_CLASS_CEILING] && !allowedContact) {
      return HIDDEN_DECISION({ source: 'bot_ceiling' });
    }
    if (out.reveal !== 'none') out = { ...out, reveal: 'none' };
  }
  // Гость ссылки: только публичные поля; вебхук и ИИ — без раскрытия
  if (viewer.purpose === 'guest' && cls !== 'public') return HIDDEN_DECISION({ source: 'purpose' });
  if (VISIBILITY_EXTERNAL_PURPOSES.includes(viewer.purpose) && out.reveal !== 'none') out = { ...out, reveal: 'none' };
  // Класс: секрет — не выше маски и без раскрытия ни для кого (включая самого человека).
  // Понижение уровня пересобирает решение через finalize: маска подбирается по полю (у `full`
  // её нет), caps уровня `full` снимаются — иначе маскированное поле фильтровалось бы и
  // сортировалось по значению (оракул), а `masked` без маски ушёл бы на провод как `hidden`.
  if (cls === 'secret') {
    const level = minVisibilityLevel(out.level, 'masked');
    if (level !== out.level) out = finalize(entry, level, out.mask, 'none', { source: 'ceiling', ceiling: 'masked' });
    else if (out.reveal !== 'none') out = { ...out, reveal: 'none' };
  } else if (cls === 'restricted' && !isSelf && out.level === 'full') {
    // Строгое: полное значение — только раскрытием ОДНОЙ записи (решение грилла №3)
    const reveal = viewer.kind === 'user' && !VISIBILITY_EXTERNAL_PURPOSES.includes(viewer.purpose) ? 'one' : 'none';
    out = finalize(entry, VISIBILITY_CLASS_CEILING.restricted, out.mask, reveal, { ...out.why, ceiling: 'masked' });
  }
  return out;
}

/**
 * Уровень → маска/caps (masked без допустимой маски = hidden: «частично» из ничего не нарисовать).
 * Раскрывается только маска: у `hidden` раскрытия нет (сервис раскрытия требует `masked`).
 */
function finalize(entry: VisibilityFieldEntry, level: VisibilityLevel, mask: VisibilityMaskKind | null, reveal: VisibilityRevealMode, why: VisibilityWhyDto): FieldDecision {
  if (level === 'full') return { level, mask: null, reveal: 'none', caps: [...(entry.def.caps ?? [])], why };
  if (level === 'masked') {
    const m = pickMask(entry, mask);
    if (m) return { level, mask: m, reveal, caps: [], why };
  }
  return { level: 'hidden', mask: null, reveal: 'none', caps: [], why };
}

/**
 * СЛУЖЕБНОЕ поле (`control: controller`, решает организация — решение грилла №1/№2).
 * 1) сам → по `self` реестра (обязательная видимость не переопределяется правилами);
 * 2) по каждому столбцу зрителя — самое специфичное правило (поле > группа > секция), нет
 *    правила — умолчание реестра (роль / относительный вид); столбцы оргструктуры без правила
 *    не вносят ничего;
 * 3) явный запрет (deny) побеждает всё; иначе MAX уровня; раскрытие — объединение;
 * 4) потолки: класс, бот/ключ, назначение.
 */
export function decideControllerField(
  recordType: string,
  entry: VisibilityFieldEntry,
  policy: CompiledPolicy,
  viewer: ViewerFacts,
  rel: RowRelation,
): FieldDecision {
  if (viewer.kind === 'system') return finalize(entry, 'full', null, 'none', { source: 'purpose' });
  const selfMode = entry.def.self ?? 'full';
  if (rel.self && selfMode !== 'policy') {
    if (selfMode === 'hidden') return HIDDEN_DECISION({ source: 'self' });
    const src = (entry.def.mandatoryVisible ?? []).includes('self') ? 'mandatory' : 'self';
    return applyCeilings(entry, viewer, finalize(entry, 'full', null, 'none', { source: src }), true);
  }

  const defaults = visibilityFieldDefaults(recordType, entry.key);
  const contributions: Contribution[] = [];
  for (const col of viewerColumns(viewer, rel)) {
    const rule = ruleForColumn(policy, entry, col.kind, col.id, rel.stage);
    if (rule) {
      contributions.push({
        effect: rule.effect,
        level: rule.effect === 'deny' ? 'hidden' : rule.level,
        mask: rule.mask,
        reveal: rule.reveal,
        why: { source: rule.effect === 'deny' ? 'deny' : 'rule', ruleId: rule.id, audience: { kind: col.kind, id: col.id } },
      });
      continue;
    }
    if (col.kind === 'role' && col.id) {
      const role = col.id as WorkspaceRole;
      const lv = defaults.roles?.[role];
      if (lv) {
        contributions.push({
          effect: 'allow',
          level: lv,
          mask: null,
          reveal: defaults.reveal?.includes(role) ? 'one' : 'none',
          why: { source: 'default', role },
        });
      }
    } else if (col.kind === 'manager_of' || col.kind === 'branch_head_of' || col.kind === 'branch_payroll' || col.kind === 'branch_scheduler') {
      const lv = defaults.relative?.[col.kind];
      if (lv) contributions.push({ effect: 'allow', level: lv, mask: null, reveal: 'none', why: { source: 'default', relative: col.kind } });
    }
  }

  const deny = contributions.find((c) => c.effect === 'deny');
  if (deny) return HIDDEN_DECISION(deny.why);
  if (!contributions.length) return HIDDEN_DECISION({ source: 'default' });

  let level: VisibilityLevel = 'hidden';
  for (const c of contributions) level = maxVisibilityLevel(level, c.level);
  const top = contributions.find((c) => c.level === level)!;
  // Раскрытие: `one` — у любого вклада; `delegated` — только при включённом делегировании и только
  // на «свои» записи (руководитель субъекта или объекта), решение грилла №7
  const ownRecord = rel.managerOf || rel.branchHead;
  const canReveal = contributions.some((c) => c.reveal === 'one' || (c.reveal === 'delegated' && viewer.revealDelegation && ownRecord));
  const reveal: VisibilityRevealMode = level === 'full' ? 'none' : canReveal && viewer.kind === 'user' ? 'one' : 'none';
  return applyCeilings(entry, viewer, finalize(entry, level, top.mask, reveal, top.why), false);
}

/** Аудитории личного поля: из политики человека (если настраивал) либо умолчание реестра. */
export interface PersonalFieldSetting {
  configured: boolean;
  audiences: Array<{ kind: 'everybody' | 'circle_all' | 'circle' | 'colleagues'; id: string | null }>;
  always: ReadonlySet<string>;
  never: ReadonlySet<string>;
  /** «Скрыть от Группы» (редактор Группы): сильнее аудиторий, слабее «Всегда» конкретному человеку */
  hiddenFromCircles: ReadonlySet<string>;
}

/** Собрать настройку личного поля из правил политики человека (сироты — игнорировать). */
export function personalSetting(recordType: string, entry: VisibilityFieldEntry, policy: CompiledPolicy): PersonalFieldSetting {
  const always = new Set<string>();
  const never = new Set<string>();
  const hiddenFromCircles = new Set<string>();
  const audiences: PersonalFieldSetting['audiences'] = [];
  let configured = false;
  for (const r of policy.rules) {
    if (r.fieldKey !== entry.key) continue;
    if (r.audienceKind === 'user' && r.audienceId) {
      (r.effect === 'deny' ? never : always).add(r.audienceId);
      continue;
    }
    // «Скрыть от Группы» — исключение, а не настройка аудиторий: умолчания поля сохраняются
    if (r.audienceKind === 'circle' && r.effect === 'deny' && r.audienceId) {
      hiddenFromCircles.add(r.audienceId);
      continue;
    }
    // Маркер «Никто»: настроено, аудиторий нет (запрет «всем» — не запрет, исключения «всегда» работают)
    if (r.audienceKind === 'everybody' && r.effect === 'deny') {
      configured = true;
      continue;
    }
    if (r.effect === 'allow' && (r.audienceKind === 'everybody' || r.audienceKind === 'circle_all' || r.audienceKind === 'circle' || r.audienceKind === 'colleagues')) {
      configured = true;
      audiences.push({ kind: r.audienceKind, id: r.audienceId ?? null });
    }
  }
  // Поле не настраивается (фиксированное умолчание) либо человек его не трогал — умолчание реестра
  if (!configured || !isVisibilityFieldConfigurable(recordType, entry.key)) {
    const defs = (visibilityFieldDefaults(recordType, entry.key).audiences ?? []) as readonly VisibilityPersonalDefault[];
    return { configured: false, audiences: defs.map((kind) => ({ kind, id: null })), always, never, hiddenFromCircles };
  }
  return { configured, audiences, always, never, hiddenFromCircles };
}

function audienceMatches(a: PersonalFieldSetting['audiences'][number], rel: PersonalRelation): boolean {
  switch (a.kind) {
    case 'everybody':
      return true;
    case 'circle_all':
      return rel.linked;
    case 'circle':
      return !!a.id && rel.circleIds.has(a.id);
    case 'colleagues':
      return a.id ? rel.colleagueWorkspaceIds.has(a.id) : rel.colleagueWorkspaceIds.size > 0;
    default:
      return false;
  }
}

/**
 * ЛИЧНОЕ поле (`control: subject`): решает только сам человек (решение грилла №1/№8).
 * Сам → full. «Никогда» > «Всегда» > аудитории (Группы, Окружение, коллеги, все) > запасной
 * уровень (знакомый — маска поля, если объявлена; посторонний — как объявлено). Взаимность
 * присутствия: скрыл своё — чужое не выше корзины.
 */
export function decidePersonalField(recordType: string, entry: VisibilityFieldEntry, setting: PersonalFieldSetting, viewer: ViewerFacts, rel: PersonalRelation): FieldDecision {
  if (viewer.kind === 'system') return finalize(entry, 'full', null, 'none', { source: 'purpose' });
  if (rel.self) return finalize(entry, 'full', null, 'none', { source: 'self' });
  const viewerId = viewer.userId;
  let d: FieldDecision;
  if (viewerId && setting.never.has(viewerId)) {
    d = HIDDEN_DECISION({ source: 'personal_exception', audience: { kind: 'user', id: viewerId } });
  } else if (viewerId && setting.always.has(viewerId)) {
    d = finalize(entry, 'full', null, 'none', { source: 'personal_exception', audience: { kind: 'user', id: viewerId } });
  } else if ([...rel.circleIds].some((c) => setting.hiddenFromCircles.has(c))) {
    // Скрыто от Группы, в которой зритель: знакомому — запасной уровень поля (маска номера), не больше
    const c = [...rel.circleIds].find((x) => setting.hiddenFromCircles.has(x))!;
    d = finalize(entry, entry.def.fallback?.known ?? 'hidden', null, 'none', { source: 'personal_exception', audience: { kind: 'circle', id: c } });
  } else {
    const hit = setting.audiences.find((a) => audienceMatches(a, rel));
    if (hit) {
      d = finalize(entry, 'full', null, 'none', { source: 'personal', audience: { kind: hit.kind, id: hit.id } });
    } else {
      const known = rel.linked || rel.colleagueWorkspaceIds.size > 0;
      const fb = (known ? entry.def.fallback?.known : entry.def.fallback?.stranger) ?? 'hidden';
      d = finalize(entry, fb, null, 'none', { source: 'personal_fallback' });
    }
  }
  if (entry.def.reciprocal && rel.viewerHidesOwnPresence && d.level === 'full') {
    d = finalize(entry, 'masked', null, 'none', { source: 'reciprocal' });
  }
  return applyCeilings(entry, viewer, d, false);
}

/** Значение к маске: дата — днём, bigint — строкой (маски работают со строками и числами). */
export function normalizeForMask(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'bigint') return v.toString();
  return v;
}

/**
 * Решение → значение провода. Сырое значение выходит ТОЛЬКО на уровне `full`; `masked` несёт
 * лишь отображение маски; `masked` без маски и `hidden` — маркер без значения. Чистая функция:
 * инвариант «ниже full значение не выходит» проверяет `verify-visibility-plan.cjs`.
 */
export function projectValue(entry: VisibilityFieldEntry, d: FieldDecision, value: unknown): Guarded<unknown> {
  if (d.level === 'full') return value;
  if (d.level === 'hidden' || !d.mask) return HIDDEN;
  const masked: Masked = {
    $v: 'masked',
    mask: d.mask,
    display: applyMask(d.mask, normalizeForMask(value), { moneyBuckets: entry.def.moneyBuckets }),
    reveal: value === null || value === undefined ? 'none' : d.reveal,
  };
  return masked;
}

/** Уровень A не ниже B? (для инвариантов и диффа) */
export function levelAtLeast(a: VisibilityLevel, b: VisibilityLevel): boolean {
  return VISIBILITY_LEVEL_RANK[a] >= VISIBILITY_LEVEL_RANK[b];
}
