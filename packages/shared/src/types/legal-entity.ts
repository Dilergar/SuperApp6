import type { WorkspaceBankAccountDto, WorkspaceRequisitesDto } from './workspace';

/**
 * Юрлицо организации (ТОО/ИП) — сторона договора и владелец счетов.
 * Workspace = бренд, LegalEntity = кто подписывает. Ровно одно головное (isHead):
 * его отдаёт старая ручка `/requisites`.
 */
export interface LegalEntityDto extends WorkspaceRequisitesDto {
  id: string;
  name: string;
  isHead: boolean;
  sortOrder: number;
  /** ISO datetime; не null → в архиве (не выбирается в новых договорах) */
  archivedAt: string | null;
}

/** Короткая форма для выпадашек и снимков «в каком ТОО оформлен» */
export interface LegalEntityLiteDto {
  id: string;
  name: string;
  isHead: boolean;
  bin: string | null;
  archivedAt: string | null;
}

export type { WorkspaceBankAccountDto };
