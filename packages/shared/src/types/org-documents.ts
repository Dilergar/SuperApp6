import type {
  DocCategory,
  DocFieldKind,
  DocSignatureLevel,
  DocStatus,
  DocVisibility,
} from '../constants/org-documents';
import type { SignActStatus, SignLevel, SignRequestStatus } from '../constants/sign';
import type { BuilderDoc, DocTemplateKind } from './doc-builder';
import type { CounterpartyLiteDto } from './counterparty';
import type { SignSummaryDto } from './sign';

// ============================================================
// Сервис «Документы» (B2B) — DTO.
// НЕ путать с `types/document.ts`: там движок core/docs.
// ============================================================

export interface DocTypeDto {
  id: string;
  workspaceId: string;
  name: string;
  category: DocCategory;
  numberFormat: string | null;
  visibility: DocVisibility;
  /** Чем подписывается документ этого вида (core/sign) */
  signatureLevel: DocSignatureLevel;
  toPersonalFile: boolean;
  sortOrder: number;
  /** Сколько шаблонов у вида — подсказка в справочнике */
  templatesCount?: number;
  createdAt: string;
}

/** Поле формы подачи: то, что сотрудник заполняет перед отправкой документа */
export interface DocFormFieldDto {
  key: string;
  label: string;
  kind: DocFieldKind;
  required?: boolean;
  placeholder?: string;
  /** Для kind='select' */
  options?: { value: string; label: string }[];
}

export interface DocTemplateDto {
  id: string;
  workspaceId: string;
  docTypeId: string;
  docTypeName: string;
  category: DocCategory;
  /**
   * Чем подписывается ВИД документа — денормализовано с DocType. Нужно тут же,
   * где строится заготовка маршрута: без этого поля кнопка «Маршрут» ставила бы
   * в кадровый маршрут шаг «Подписать» без требования подписи, и приказ
   * закрывался бы нажатием кнопки.
   */
  signatureLevel: DocSignatureLevel;
  name: string;
  description: string | null;
  /** Вид бланка: 'docx' — загруженный Word, 'builder' — собран в блочном конструкторе */
  kind: DocTemplateKind;
  /** Блоки конструктора (kind='builder'); у docx-шаблонов null */
  builderDoc: BuilderDoc | null;
  /** Бланк: документ core/docs (правится общим редактором) */
  documentId: string | null;
  fileId: string | null;
  fields: DocFormFieldDto[];
  selfService: boolean;
  status: 'draft' | 'published';
  version: number;
  /** Есть ли опубликованный маршрут (триггер «Документ отправлен») */
  hasRoute?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Кому доступен шаблон (гранты core/access) */
export interface DocTemplateGrantDto {
  principalType: 'user' | 'department' | 'position' | 'branch';
  principalId: string;
  /** Имя получателя (сотрудник, отдел, должность, филиал); null — запись уже удалена */
  label: string | null;
}

/** Контактное лицо контрагента на карточке документа (узкий срез) */
export interface OrgDocumentContactRef {
  id: string;
  name: string;
  position: string | null;
}

/**
 * ВНЕШНИЙ ЭТАП документа (категория «С контрагентами»): состояние доставки и
 * подписания второй стороной. Живёт отдельным блоком от `sign` намеренно:
 * подписи (акты, протокол, экспорт) рисует `SignaturesBlock`, а этот блок
 * отвечает только за этап и доставку — дублировать акты в двух местах нельзя.
 */
export interface OrgDocumentExternalDto {
  requestId: string;
  status: SignRequestStatus;
  level: SignLevel;
  expiresAt: string | null;
  /** Гостевая ссылка контрагенту; null — ещё не создана либо уже отозвана */
  link: { url: string; revoked: boolean } | null;
  internalActs: {
    userId: string;
    name: string;
    status: SignActStatus;
    signedAt: string | null;
  }[];
  /** Акт внешнего подписанта; null — гость ещё не открывал документ */
  guestAct: {
    name: string;
    phoneMasked: string | null;
    status: SignActStatus;
    signedAt: string | null;
    declineReason: string | null;
    /** Номер гостя совпал с телефоном выбранного контакта (мягкая сверка ПЭП) */
    matchesContact: boolean;
  } | null;
  /** Сколько раз ссылку открывали и когда в последний раз */
  opens: { count: number; lastOpenedAt: string | null } | null;
  /** SMS-доставка доступна (живой драйвер + у контакта есть номер) */
  smsAvailable: boolean;
  /** Штампованная копия (PDF с полосами и «Листом подписей») */
  stamped: { ready: boolean; url: string | null };
}

export interface OrgDocumentDto {
  id: string;
  workspaceId: string;
  docTypeId: string;
  docTypeName: string;
  category: DocCategory;
  templateId: string | null;
  templateName: string | null;
  title: string;
  status: DocStatus;
  number: string | null;
  numberedAt: string | null;
  subjectUserId: string | null;
  subjectName: string | null;
  /** Контрагент — вторая сторона (виды «С контрагентами»); null у внутренних */
  counterparty: CounterpartyLiteDto | null;
  counterpartyContact: OrgDocumentContactRef | null;
  createdById: string;
  createdByName: string | null;
  documentId: string | null;
  fileId: string | null;
  pdfFileId: string | null;
  /** Снимок блоков конструктора (документ по builder-шаблону или свободный); у docx-документов null */
  builderDoc: BuilderDoc | null;
  fields: Record<string, unknown>;
  /**
   * Объявление полей документа: у документа ПО ШАБЛОНУ — форма подачи шаблона,
   * у свободного — его собственные поля. Карточка и конструктор рисуют их теми же
   * контролами, что подача (дата — календарём, период — парой календарей).
   */
  formFields: DocFormFieldDto[];
  approvalRequestId: string | null;
  processInstanceId: string | null;
  parentDocumentId: string | null;
  signedAt: string | null;
  /**
   * Содержимое СЕЙЧАС пересобирается фоном (правка полей/тела/контрагента, номер).
   * Пока true, страж отправки ответит отказом — веб гасит кнопки «Отправить…» и
   * опрашивает карточку, вместо того чтобы предлагать клик в гарантированный 400.
   * Есть только на карточке (`get`); списки его не считают.
   */
  rebuilding?: boolean;
  /**
   * Электронные подписи под документом (core/sign): кто подписал, чем и когда,
   * плюс мой акт, если очередь дошла до меня. null — под документом не собирали
   * ни одной подписи (или зритель их видеть не вправе).
   */
  sign?: SignSummaryDto | null;
  /** Внешний этап (категория «С контрагентами»); null — не отправлялся */
  external?: OrgDocumentExternalDto | null;
  createdAt: string;
  updatedAt: string;
  /** Что зритель может сделать — считает сервер, кнопки рисуются по этому */
  can?: {
    edit: boolean;
    submit: boolean;
    cancel: boolean;
    /** Вернуть с маршрута в черновик — пока по документу никто не начал решать */
    withdraw: boolean;
    manage: boolean;
    /** Присвоить номер черновику (external: номер печатается в тексте ДО отправки) */
    assignNumber?: boolean;
    /** Отправить контрагенту (external, из черновика) */
    sendExternal?: boolean;
    /** Отозвать отправку (external, из `sent`) */
    revokeExternal?: boolean;
    /** Вернуть в черновик после отказа контрагента (`declined_external`) */
    returnToDraft?: boolean;
  };
}

export interface OrgDocumentListDto {
  items: OrgDocumentDto[];
  total: number;
}

/** «Что я могу подать» — витрина самообслуживания сотрудника */
export interface AvailableTemplateDto {
  id: string;
  name: string;
  description: string | null;
  docTypeId: string;
  docTypeName: string;
  category: DocCategory;
  kind: DocTemplateKind;
  fields: DocFormFieldDto[];
}
