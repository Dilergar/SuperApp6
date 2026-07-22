import type { ChatterCategory, ChatterTypeKey } from '../constants/chatter';

// ============================================
// core/chatter («Хроника записи») — типы
// Запись хроники полиморфна по refType+refId; id — BigInt в БД,
// на проводе ВСЕГДА string (JSON.stringify на BigInt бросает).
// ============================================

export type { ChatterCategory, ChatterTypeKey };

/** Одно изменение поля «было → стало» (display-ready строки, готовые к показу) */
export interface ChatterChange {
  field: string;
  /** «Срок», «Приоритет», «Роль»… */
  label: string;
  from: string | null;
  to: string | null;
}

/** Лайт-профиль актёра для PersonChip (батч-обогащение страницы) */
export interface ChatterActorLite {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

export interface ChatterEntryDto {
  /** BigInt id → string; он же курсор */
  id: string;
  refType: string;
  refId: string;
  workspaceId: string | null;
  /** null = система (крон/движок) */
  actorId: string | null;
  /** Снапшот имени — хроника переживает удаление аккаунта */
  actorName: string | null;
  /** ChatterTypeKey на практике; string на проводе — форвард-совместимость со старыми клиентами */
  typeKey: string;
  changes: ChatterChange[] | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface ChatterPageDto {
  items: ChatterEntryDto[];
  nextCursor: string | null;
  /**
   * actorId → лайт-профиль для PersonChip. Удалённые/анонимизированные
   * пользователи отсутствуют — клиент падает на снапшот actorName.
   */
  actors: Record<string, ChatterActorLite>;
}
