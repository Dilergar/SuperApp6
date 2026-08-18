import type { CounterpartyKind } from '../constants/counterparties';

// ============================================================
// Сервис «Контрагенты» — DTO. Каждый тип стоит на ОБЕИХ сторонах провода
// (правило «Контракт API ↔ клиенты»).
// ============================================================

/** Контактное лицо контрагента: кому уходит документ на подпись */
export interface CounterpartyContactDto {
  id: string;
  counterpartyId: string;
  name: string;
  position: string | null;
  /** Нормализованный номер: канал SMS-доставки ссылки и мягкая сверка личности ПЭП */
  phone: string | null;
  email: string | null;
  createdAt: string;
}

/** Банковский счёт контрагента — реквизит для будущих счетов на оплату */
export interface CounterpartyBankAccountDto {
  id: string;
  iban: string;
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
  signBasis: string | null;
  phone: string | null;
  email: string | null;
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
