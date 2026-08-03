import type { DocCategory, DocFieldKind, DocStatus, DocVisibility } from '../constants/org-documents';

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
  name: string;
  description: string | null;
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
  createdById: string;
  createdByName: string | null;
  documentId: string | null;
  fileId: string | null;
  pdfFileId: string | null;
  fields: Record<string, unknown>;
  approvalRequestId: string | null;
  processInstanceId: string | null;
  parentDocumentId: string | null;
  signedAt: string | null;
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
  fields: DocFormFieldDto[];
}
