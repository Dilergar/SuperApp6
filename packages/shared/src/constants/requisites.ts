// ============================================================
// Реквизиты (Казахстан) — справочники и подписи.
//
// Единый источник для ДВУХ анкет: организации («Анкета компании» — юрформа,
// налоговый режим, БИН, банк) и человека («Моя Анкета» — ИИН, адрес,
// удостоверение; карта — в «Кошельке»). На этих полях стоит документная
// вертикаль: договоры, счета, ЭДО, КЭДО. Правило платформы: данные вводятся
// ОДИН раз в своей анкете, потребители читают их отсюда.
// ============================================================

/** Организационно-правовые формы РК (v1 — ходовые; «Другое» закрывает хвост) */
export const ORG_FORMS = [
  { value: 'ip', label: 'ИП' },
  { value: 'too', label: 'ТОО' },
  { value: 'ao', label: 'АО' },
  { value: 'kh', label: 'КХ / ФХ' },
  { value: 'pk', label: 'ПК (кооператив)' },
  { value: 'gu', label: 'ГУ (гос. учреждение)' },
  { value: 'institution', label: 'Учреждение' },
  { value: 'fond', label: 'Фонд / ОО' },
  { value: 'branch', label: 'Филиал / представительство' },
  { value: 'other', label: 'Другое' },
] as const;
export type OrgForm = (typeof ORG_FORMS)[number]['value'];

/**
 * ПОЛНАЯ форма юрнаименования по орг-форме — приставка и хвост, между которыми
 * человек вводит только само название («Ромашка» → «Товарищество с ограниченной
 * ответственностью «Ромашка»»). Полная расшифровка — то, что юристы пишут в
 * преамбуле договора (решение продукта 2026-08-18); короткое имя и так живёт в
 * рабочем имени карточки. null — формы со свободным наименованием (филиал,
 * «Другое»): у них приставку не навязываем.
 */
export const ORG_FORM_LEGAL_WRAP: Record<OrgForm, { pre: string; post: string } | null> = {
  too: { pre: 'Товарищество с ограниченной ответственностью «', post: '»' },
  ao: { pre: 'Акционерное общество «', post: '»' },
  // ИП чаще именуется по ФИО («Индивидуальный предприниматель Иванов И. И.»),
  // поэтому без кавычек — в поле вводят ФИО либо фирменное имя как есть.
  ip: { pre: 'Индивидуальный предприниматель ', post: '' },
  kh: { pre: 'Крестьянское хозяйство «', post: '»' },
  pk: { pre: 'Производственный кооператив «', post: '»' },
  gu: { pre: 'Государственное учреждение «', post: '»' },
  institution: { pre: 'Учреждение «', post: '»' },
  fond: { pre: 'Фонд «', post: '»' },
  branch: null,
  other: null,
};

/** Налоговые режимы РК (v1 — ходовые; «Другое» закрывает хвост) */
export const TAX_REGIMES = [
  { value: 'general', label: 'Общеустановленный' },
  { value: 'simplified', label: 'Упрощённая декларация' },
  { value: 'retail', label: 'Розничный налог' },
  { value: 'patent', label: 'Патент' },
  { value: 'snr_kh', label: 'СНР для крестьянских хозяйств' },
  { value: 'astana_hub', label: 'Astana Hub' },
  { value: 'other', label: 'Другое' },
] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number]['value'];

/**
 * Ключи РЕКВИЗИТНЫХ полей человека в мешке `extras` карты «Видимость в
 * Компаниях» (companyCardVisibility). Мешок и был заведён под такие расширения:
 * отсутствующий ключ = выключено, то есть требуемое умолчание «конфиденциальное
 * коллегам скрыто» получается без миграций карт.
 *
 * ВАЖНО: эти тумблеры действуют только на КОЛЛЕГ. Управляющим (manager+) блок
 * реквизитов виден ВСЕГДА и не выключается — это данные для договоров и
 * трудоустройства (второй, нередактируемый уровень «Видимости в Компаниях»).
 * В ЛИЧНОМ окружении (Группы) реквизиты не показываются вовсе.
 */
export const REQUISITE_VISIBILITY_EXTRAS = {
  iin: 'iin',
  residentialAddress: 'residentialAddress',
  idDocument: 'idDocument',
  paymentCard: 'paymentCard',
} as const;

export const REQUISITE_VISIBILITY_LABELS: Record<
  (typeof REQUISITE_VISIBILITY_EXTRAS)[keyof typeof REQUISITE_VISIBILITY_EXTRAS],
  string
> = {
  iin: 'ИИН',
  residentialAddress: 'Адрес проживания',
  idDocument: 'Удостоверение личности',
  paymentCard: 'Карта для выплат',
};

/** Названия месяцев для раздельного ввода даты рождения (день / месяц / год) */
export const MONTH_NAMES_RU = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

export const REQUISITE_LIMITS = {
  legalNameMaxLength: 200,
  addressMaxLength: 300,
  bankNameMaxLength: 120,
  signBasisMaxLength: 160,
  idDocNumberMaxLength: 20,
  idDocIssuedByMaxLength: 120,
  holderNameMaxLength: 60,
  /** Карт у человека (Kaspi Gold + зарплатная + запас) */
  maxCardsPerUser: 5,
  /** Банковских счетов у организации */
  maxBankAccountsPerWorkspace: 10,
} as const;
