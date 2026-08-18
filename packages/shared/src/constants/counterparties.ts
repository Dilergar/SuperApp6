// ============================================================
// Сервис «Контрагенты» (B2B) — справочник ВНЕШНИХ организаций и людей,
// с которыми компания ведёт дела. ОДИН на организацию: его читают
// «Документооборот» (договоры/АВР наружу), а дальше — Счета, Финансы B2B,
// ЭСФ, CRM и импорт выписки. Свой список контрагентов каждый сервис не заводит.
//
// Контрагент — НЕ пользователь платформы: подписывает по гостевой ссылке
// (core/share-links + core/sign). БИН — якорь будущего связывания
// workspace↔workspace, когда контрагент тоже заведёт организацию в SuperApp6.
// ============================================================

/** Полиморфный ключ карточки контрагента (chatter, search, EntitySelector) */
export const COUNTERPARTY_REF_TYPE = 'counterparty';

/**
 * Вид контрагента. От него зависит, ЧТО лежит в поле `bin` (БИН у юрлица,
 * ИИН у ИП и физлица — алгоритм контрольной суммы один и тот же) и с чем
 * сверяется сертификат ЭЦП внешнего подписанта (`certSubjectBin` у юрлица,
 * `certSubjectIin` у ИП и физлица).
 */
export const COUNTERPARTY_KINDS = [
  { value: 'legal', label: 'Юридическое лицо' },
  { value: 'entrepreneur', label: 'ИП' },
  { value: 'individual', label: 'Физическое лицо' },
] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number]['value'];

export const COUNTERPARTY_KIND_LABELS: Record<CounterpartyKind, string> = {
  legal: 'Юридическое лицо',
  entrepreneur: 'ИП',
  individual: 'Физическое лицо',
};

/** Подпись идентификатора по виду: у юрлица это БИН, у ИП и физлица — ИИН */
export function counterpartyIdLabel(kind: CounterpartyKind): string {
  return kind === 'legal' ? 'БИН' : 'ИИН';
}

/**
 * «Вид» в форме контрагента — ЕДИНЫЙ список орг-форм РК (решение продукта
 * 2026-08-18): человек выбирает ТОО/АО/ИП/…, а `kind` (что лежит в bin и с чем
 * сверяется ЭЦП) и приставка юрнаименования выводятся из выбора сами.
 */
export const COUNTERPARTY_FORM_OPTIONS = [
  { value: 'too', label: 'ТОО', kind: 'legal', orgForm: 'too' },
  { value: 'ao', label: 'АО', kind: 'legal', orgForm: 'ao' },
  { value: 'ip', label: 'ИП', kind: 'entrepreneur', orgForm: 'ip' },
  // КХ обычно действует без образования юрлица (глава = ИП) → идентификатор ИИН
  { value: 'kh', label: 'КХ / ФХ', kind: 'entrepreneur', orgForm: 'kh' },
  { value: 'pk', label: 'ПК (кооператив)', kind: 'legal', orgForm: 'pk' },
  { value: 'gu', label: 'ГУ (гос. учреждение)', kind: 'legal', orgForm: 'gu' },
  { value: 'institution', label: 'Учреждение', kind: 'legal', orgForm: 'institution' },
  { value: 'fond', label: 'Фонд / ОО', kind: 'legal', orgForm: 'fond' },
  { value: 'branch', label: 'Филиал / представительство', kind: 'legal', orgForm: 'branch' },
  { value: 'individual', label: 'Физическое лицо', kind: 'individual', orgForm: null },
  { value: 'other', label: 'Другое (юрлицо)', kind: 'legal', orgForm: 'other' },
] as const;
export type CounterpartyFormOption = (typeof COUNTERPARTY_FORM_OPTIONS)[number];

/**
 * Параметры запроса для фильтра «Вид» — ОДИН источник и для формы, и для списка.
 * У формы выбор — орг-форма (ТОО/АО/ИП…), поэтому и фильтруем по ней; у видов
 * без орг-формы (физлицо) фильтр идёт по `kind`. Без этой функции список и форма
 * разъезжались: в форме 11 видов, в фильтре — 3 широких «kind».
 */
export function counterpartyFormQuery(value: string | null | undefined): {
  orgForm?: string;
  kind?: CounterpartyKind;
} {
  const o = COUNTERPARTY_FORM_OPTIONS.find((x) => x.value === value);
  if (!o) return {};
  return o.orgForm ? { orgForm: o.orgForm } : { kind: o.kind as CounterpartyKind };
}

/** КБе по умолчанию: 17 — юрлица-резиденты, 19 — физлица и ИП (резиденты) */
export function defaultKbeFor(kind: CounterpartyKind): string {
  return kind === 'legal' ? '17' : '19';
}

/**
 * Основание подписи — НА ОСНОВАНИИ ЧЕГО подписант вправе подписывать: в шапке
 * договора пишут «в лице Директора Ивановой, действующей на основании Устава».
 * Готовый список вместо свободного поля (решение продукта 2026-08-18); значения
 * в родительном падеже — так они встают после «на основании …».
 */
export const SIGN_BASIS_OPTIONS = [
  { value: 'ustav', label: 'Устава', needsDetail: false },
  { value: 'svid_ip', label: 'Свидетельства о регистрации ИП', needsDetail: false },
  // needsDetail: у документа-основания есть НОМЕР и ДАТА — форма спрашивает их
  // раздельно (номер полем, дата календарём) и склеивает «Доверенности № 5 от 01.02.2026»
  { value: 'doverennost', label: 'Доверенности', needsDetail: true, numberPlaceholder: '5' },
  { value: 'prikaz', label: 'Приказа', needsDetail: true, numberPlaceholder: '12-к' },
  { value: 'polozhenie', label: 'Положения', needsDetail: false },
  { value: 'custom', label: 'Свой вариант', needsDetail: false },
] as const;

export const COUNTERPARTY_LIMITS = {
  /** Анти-мусорный потолок справочника (2000 живых на организацию) */
  maxPerWorkspace: 2000,
  /** Контактные лица одного контрагента */
  maxContactsPerCounterparty: 20,
  /** Банковские счета одного контрагента */
  maxBankAccountsPerCounterparty: 10,
  maxNameLength: 200,
  /** Страница списка */
  pageSize: 50,
  maxPageSize: 200,
} as const;
