import type { CounterpartyKind, SignBasisKind, SignBasisParts } from '../constants/counterparties';
import type { Guarded } from '../visibility/types';

// ============================================================
// Сервис «Контрагенты» — DTO. Каждый тип стоит на ОБЕИХ сторонах провода
// (правило «Контракт API ↔ клиенты»).
// ============================================================

/**
 * Основание подписи НА ПРОВОДЕ — структура, а не готовая фраза: так она и
 * ХРАНИТСЯ. Печатное словосочетание собирается на выходе (`composeSignBasis`):
 * в языке зрителя на экране и в языке БЛАНКА внутри документа.
 */
export interface SignBasisInput {
  kind: SignBasisKind;
  /** Номер документа-основания («5», «12-к») — только у видов с `needsDetail` */
  number?: string;
  /** YYYY-MM-DD — дата документа-основания */
  date?: string;
  /** Своя формулировка целиком (`kind: 'custom'`) */
  text?: string;
}

/** Контактное лицо контрагента: кому уходит документ на подпись */
export interface CounterpartyContactDto {
  id: string;
  counterpartyId: string;
  name: string;
  position: string | null;
  /**
   * Нормализованный номер: канал SMS-доставки ссылки и мягкая сверка личности ПЭП. Кто видит —
   * правила организации (core/visibility, `counterparty.contactPhone`): стажёру и сотруднику — маской
   */
  phone: Guarded<string | null>;
  email: Guarded<string | null>;
  createdAt: string;
}

/** Банковский счёт контрагента — реквизит для будущих счетов на оплату */
export interface CounterpartyBankAccountDto {
  id: string;
  /** Конфиденциально (`counterparty.iban`): по умолчанию стажёру и сотруднику — последние четыре */
  iban: Guarded<string>;
  bankName: string;
  bik: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface CounterpartyDto {
  id: string;
  workspaceId: string;
  kind: CounterpartyKind;
  /** Рабочее имя («Ромашка») — то, что видно в списках */
  name: string;
  /** Полное юрнаименование («ТОО „Ромашка"») — то, что идёт в договор */
  legalName: string | null;
  /** БИН юрлица / ИИН ИП и физлица (12 цифр, контрольная сумма) */
  bin: string | null;
  orgForm: string | null;
  legalAddress: string | null;
  /** Фактический адрес; null = совпадает с юридическим */
  actualAddress: string | null;
  kbe: string | null;
  /** Налоговый режим (справочник TAX_REGIMES); null = не указан */
  taxRegime: string | null;
  vatPayer: boolean;
  vatSeries: string | null;
  vatNumber: string | null;
  /** YYYY-MM-DD */
  vatDate: string | null;
  /** Руководитель — ТЕКСТ (человек вне платформы, user_id у него нет) */
  directorName: string | null;
  /**
   * Печатная строка для шапки договора («Устава», «Приказа № 12-к от 15.01.2026»)
   * — СОБРАННАЯ на выходе, в языке зрителя: на экране карточки её читает человек.
   * В документ она попадает не отсюда, а из группы полей шаблона, где язык свой.
   */
  signBasis: string | null;
  /** Она же полями формы — так она и хранится */
  signBasisParts: SignBasisParts | null;
  /** Контакты организации-контрагента — правила организации (`counterparty.phone|email`) */
  phone: Guarded<string | null>;
  email: Guarded<string | null>;
  comment: string | null;
  createdById: string;
  archivedAt: string | null;
  /** Сколько документов заведено с этим контрагентом — подсказка в списке */
  documentsCount?: number;
  contacts: CounterpartyContactDto[];
  bankAccounts: CounterpartyBankAccountDto[];
  createdAt: string;
  updatedAt: string;
}

/** Лёгкий срез для вложения в чужие DTO (карточка документа, EntitySelector) */
export interface CounterpartyLiteDto {
  id: string;
  kind: CounterpartyKind;
  name: string;
  bin: string | null;
}
