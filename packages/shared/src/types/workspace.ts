import type { Guarded } from '../visibility/types';
// ============================================================
// Workspaces (B2B organizations)
// ============================================================
// A Workspace is ALWAYS a business/organization (B2B tenant). A person's personal
// life is the social graph (workspaceId = null), NOT a workspace.
// Role & permissions live in UserRole (context="workspace", tenantId=workspaceId) —
// the single source of truth. Должности/отделы/филиалы — сущности StaffModule
// (см. types/staff.ts); назначения присоединяются к member-DTO сервисом.
// These interfaces are API DTOs (assembled views), not raw DB rows: `role` on a member
// is read from UserRole, and user name/avatar are joined in by the service.

import type { SignBasisParts } from '../constants/counterparties';
import type { Locale } from '../constants/i18n';

// WorkspaceRole is defined in constants/roles.ts — re-export for convenience.
export { type WorkspaceRole } from '../constants/roles';

type WorkspaceRoleT = import('../constants/roles').WorkspaceRole;

export type WorkspaceInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface Workspace {
  id: string;
  name: string;
  logo: string | null;
  // Анкета организации (core/visibility, тип `workspace.card`): кто что видит — правила
  // видимости организации; маркер «скрыто» вместо значения, а не null.
  description: Guarded<string | null>;
  industry: Guarded<string | null>;
  city: Guarded<string | null>;
  website: Guarded<string | null>;
  contactEmail: Guarded<string | null>;
  contactPhone: Guarded<string | null>;
  /**
   * Язык БУМАГ организации: на нём печатаются договоры, приказы и счета.
   * Умолчание для новых бланков (у бланка язык можно переопределить). Не язык
   * интерфейса — тот у каждого человека свой.
   */
  documentLanguage: Locale;
  ownerId: string;
  membersCount: Guarded<number>;
  /** Active (non-cancelled) task count — present in the single-workspace view. */
  tasksCount?: number;
  isActive: boolean;
  /** Когда организацию отправили в архив (деактивировали). null у живой. */
  archivedAt?: string | null;
  /** Когда архивная организация будет удалена НАВСЕГДА (archivedAt + ретеншн). */
  purgeAt?: string | null;
  /** The viewing user's role in this workspace (from UserRole). Present in "my workspaces" lists. */
  myRole?: WorkspaceRoleT;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  /** WorkspaceMember row id (the HR card). */
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  userAvatar: string | null;
  /** Assembled from UserRole (single source of truth) — NOT stored on WorkspaceMember. */
  role: WorkspaceRoleT;
  /** Назначения должностей (StaffModule), присоединяются сервисом. */
  assignments: import('./staff').StaffAssignment[];
  /**
   * Карточка человека для КОЛЛЕГ — те же поля, что видит окружение в b2c,
   * но скрытые по «Видимости в Компаниях» владельца поля приходят null.
   * Всегда видны: имя, фамилия, телефон (+ должности в assignments).
   */
  card: import('./contact').ContactUserCard;
  /**
   * Реквизиты для договоров и трудоустройства. Управляющим (manager+) приходят
   * ВСЕГДА — это нередактируемый уровень «Видимости в Компаниях»; коллегам —
   * только поля, включённые владельцем карточки (extras), остальное null.
   * У зрителя без прав объекта нет вовсе.
   */
  requisites?: MemberRequisites;
  joinedAt: string;
}

/** Реквизитный блок сотрудника в ростере (что видит работодатель) */
export interface MemberRequisites {
  // Служебные поля организации (core/visibility, тип `staff.member`): владельцу и админу —
  // маска с раскрытием по одной записи, остальным скрыто, самому — полностью.
  iin: Guarded<string | null>;
  residentialAddress: Guarded<string | null>;
  idDocNumber: Guarded<string | null>;
  idDocIssuedBy: Guarded<string | null>;
  idDocIssuedAt: Guarded<string | null>; // ISO date
  /**
   * Основная карта для выплат. Полного номера в продукте нет НИ У КОГО (PCI DSS 3.4.1): `pan`
   * — маска последних четырёх; полный номер знает только путь выплат кошелька.
   */
  paymentCard: {
    pan: Guarded<string>;
    iban: Guarded<string | null>;
    holderName: Guarded<string>;
    /** `YYYY-MM-01` (месяц и год срока); маска — только год */
    expiry: Guarded<string>;
  } | null;
  /** Сколько полей скрыто правилами от этого зрителя (тихая строка «часть данных скрыта») */
  hiddenCount: number;
}

// ============================================================
// Реквизиты организации (юрлицо для договоров/счетов) — блок «Анкеты компании»
// ============================================================

export interface WorkspaceBankAccountDto {
  id: string;
  /** Строгое поле `workspace.card`: маска последних четырёх, раскрытие по одной записи */
  iban: Guarded<string>;
  bankName: string;
  bik: string;
  isPrimary: boolean;
}

export interface WorkspaceRequisitesDto {
  orgForm: string | null;
  taxRegime: string | null;
  legalName: string | null;
  bin: string | null;
  legalAddress: string | null;
  kbe: string | null;
  vatPayer: boolean;
  vatSeries: string | null;
  vatNumber: string | null;
  vatDate: string | null; // ISO date
  /** Директор — сотрудник организации (для PersonChip) */
  directorUserId: string | null;
  directorName: string | null;
  /**
   * Основание подписи ФРАЗОЙ для экрана — в языке зрителя. В документ печатается
   * не отсюда: там ту же структуру собирает группа полей шаблона в языке БУМАГИ.
   */
  signBasis: string | null;
  /** Она же полями формы — так она и хранится */
  signBasisParts: SignBasisParts | null;
  bankAccounts: WorkspaceBankAccountDto[];
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceLogo: string | null;
  invitedBy: string;
  invitedByName: string;
  toUserId: string | null;
  toPhone: string;
  /** Всегда trainee для новых приглашений (выбора роли больше нет). */
  role: WorkspaceRoleT;
  /** Опциональная должность + филиалы «с порога»: примет — назначения создадутся сами
   *  (по одному на филиал; сотрудник может обслуживать несколько). */
  positionId: string | null;
  positionName: string | null;
  branchIds: string[];
  branchNames: string[];
  message: string | null;
  status: WorkspaceInvitationStatus;
  expiresAt: string;
  createdAt: string;
}
