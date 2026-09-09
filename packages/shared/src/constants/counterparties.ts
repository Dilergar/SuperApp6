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
export const COUNTERPARTY_KINDS = ['legal', 'entrepreneur', 'individual'] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/**
 * Подпись идентификатора по виду: у юрлица это БИН, у ИП и физлица — ИИН.
 * Реестр называет СМЫСЛ — само слово берётся из каталога
 * (`counterparties.idLabel.<bin|iin>`): аббревиатура у каждого языка своя.
 */
export function counterpartyIdKey(kind: CounterpartyKind): 'bin' | 'iin' {
  return kind === 'legal' ? 'bin' : 'iin';
}

/**
 * «Вид» в форме контрагента — ЕДИНЫЙ список орг-форм РК (решение продукта
 * 2026-08-18): человек выбирает ТОО/АО/ИП/…, а `kind` (что лежит в bin и с чем
 * сверяется ЭЦП) и приставка юрнаименования выводятся из выбора сами.
 */
export const COUNTERPARTY_FORM_OPTIONS = [
  { value: 'too', kind: 'legal', orgForm: 'too' },
  { value: 'ao', kind: 'legal', orgForm: 'ao' },
  { value: 'ip', kind: 'entrepreneur', orgForm: 'ip' },
  // КХ обычно действует без образования юрлица (глава = ИП) → идентификатор ИИН
  { value: 'kh', kind: 'entrepreneur', orgForm: 'kh' },
  { value: 'pk', kind: 'legal', orgForm: 'pk' },
  { value: 'gu', kind: 'legal', orgForm: 'gu' },
  { value: 'institution', kind: 'legal', orgForm: 'institution' },
  { value: 'fond', kind: 'legal', orgForm: 'fond' },
  { value: 'branch', kind: 'legal', orgForm: 'branch' },
  { value: 'individual', kind: 'individual', orgForm: null },
  { value: 'other', kind: 'legal', orgForm: 'other' },
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
 * Готовый список вместо свободного поля (решение продукта 2026-08-18).
 *
 * На проводе едет СТРУКТУРА (`SignBasisInput`), а печатную строку собирает
 * СЕРВЕР на языке бланка: словосочетание стоит в родительном падеже («на
 * основании Устава»), и собери его клиент — в русский договор уехало бы
 * английское «the Charter» того, кто выбрал English.
 */
export const SIGN_BASIS_KINDS = [
  'none',
  'ustav',
  'svid_ip',
  'doverennost',
  'prikaz',
  'polozhenie',
  'custom',
] as const;
export type SignBasisKind = (typeof SIGN_BASIS_KINDS)[number];

/**
 * Виды основания, у которых человек выбирает документ из списка (без `none` и
 * `custom` — там выбирать нечего). `needsDetail`: у документа-основания есть
 * НОМЕР и ДАТА — форма спрашивает их раздельно (номер полем, дата календарём),
 * а сервер склеивает «Доверенности № 5 от 01.02.2026».
 */
export const SIGN_BASIS_OPTIONS = [
  { value: 'ustav', needsDetail: false },
  { value: 'svid_ip', needsDetail: false },
  { value: 'doverennost', needsDetail: true },
  { value: 'prikaz', needsDetail: true },
  { value: 'polozhenie', needsDetail: false },
] as const;

/** Основание требует номера и даты документа? */
export function signBasisNeedsDetail(kind: string): boolean {
  return SIGN_BASIS_OPTIONS.some((o) => o.value === kind && o.needsDetail);
}

/** Поля основания подписи, как они лежат в карточке (и едут по проводу). */
export interface SignBasisParts {
  kind: SignBasisKind;
  /** Номер документа-основания («5», «12-к») — только у видов с `needsDetail` */
  number: string | null;
  /** YYYY-MM-DD — дата документа-основания */
  date: string | null;
  /** Своя формулировка целиком (`kind: 'custom'`) */
  text: string | null;
}

/** Колонки карточки, в которых основание подписи ХРАНИТСЯ (обе стороны договора) */
export interface SignBasisColumns {
  signBasisKind: string | null;
  signBasisNumber: string | null;
  signBasisDate: Date | string | null;
  signBasisText: string | null;
}

/**
 * Поля формы → колонки карточки. Своя формулировка живёт только у `custom`,
 * номер и дата — только у видов с `needsDetail`: иначе в базе оседал бы мусор,
 * который потом печатался бы в договор.
 */
export function signBasisColumnsOf(
  input: { kind: string; number?: string | null; date?: string | null; text?: string | null } | null | undefined,
): SignBasisColumns {
  // Неизвестный вид = основание не указано: в базу не должно попасть то, чего
  // потом не сможет назвать ни один каталог
  if (!input || !SIGN_BASIS_KINDS.includes(input.kind as SignBasisKind) || input.kind === 'none') {
    return { signBasisKind: null, signBasisNumber: null, signBasisDate: null, signBasisText: null };
  }
  const detail = signBasisNeedsDetail(input.kind);
  return {
    signBasisKind: input.kind,
    signBasisNumber: detail ? input.number?.trim() || null : null,
    signBasisDate: detail && input.date ? new Date(`${input.date}T00:00:00.000Z`) : null,
    signBasisText: input.kind === 'custom' ? input.text?.trim() || null : null,
  };
}

/** Колонки → поля формы. `null` = основание не указано вовсе. */
export function signBasisPartsOf(row: SignBasisColumns): SignBasisParts | null {
  if (!row.signBasisKind) return null;
  const date = row.signBasisDate;
  return {
    kind: row.signBasisKind as SignBasisKind,
    number: row.signBasisNumber,
    date: date ? (typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10)) : null,
    text: row.signBasisText,
  };
}

/**
 * Структура → ПЕЧАТНАЯ строка шапки договора («Приказа № 12-к от 15.01.2026»).
 *
 * Функция общая для обеих сторон провода, потому что строку собирают обе: веб
 * рисует её предпросмотром в форме (в языке зрителя), а сервер печатает в
 * документ (в языке БЛАНКА). Слов у функции своих нет — их даёт `t`, ключи
 * относительные (неймспейс `counterparties`).
 *
 * ЦЕЛАЯ фраза берётся из каталога одним ключом, а не склеивается из кусков:
 * порядок слов принадлежит языку — по-казахски дата стоит ПЕРЕД названием
 * документа, и склейка «основание + номер + дата» дала бы там бессмыслицу.
 */
export function composeSignBasis(
  parts: Partial<SignBasisParts> | null | undefined,
  t: (key: string, values?: Record<string, string>) => string,
  formatDate: (iso: string) => string,
): string | null {
  const kind = parts?.kind;
  if (!kind || kind === 'none') return null;
  if (kind === 'custom') return parts?.text?.trim() || null;
  if (!SIGN_BASIS_OPTIONS.some((o) => o.value === kind)) return null;

  const basis = t(`signBasisPrinted.${kind}`);
  if (!signBasisNeedsDetail(kind)) return basis;
  const number = parts?.number?.trim() || null;
  const date = parts?.date ? formatDate(parts.date) : null;
  const shape = number && date ? 'withNumberDate' : number ? 'withNumber' : date ? 'withDate' : 'plain';
  return t(`signBasisFull.${shape}`, { basis, number: number ?? '', date: date ?? '' });
}

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
