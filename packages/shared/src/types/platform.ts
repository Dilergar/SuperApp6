import type { CursorPage } from './common';
import type {
  ParsedPlatformQuery,
  PlatformAccessKind,
  PlatformAuditOutcome,
  PlatformCapability,
  PlatformCommandGroup,
  PlatformEntity,
  PlatformRequestStatus,
  PlatformRisk,
  PlatformRoleKey,
  PlatformStaffStatus,
} from '../platform';
import type { VerifyStartResponse } from './verify';

// ============================================================
// core/platform — формы провода кабинета платформы
// ============================================================

// ---- Сессия и сотрудник ----

export interface PlatformStaffRoleDto {
  role: PlatformRoleKey;
  scope: { kind: 'global' };
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  reason: string;
}

export interface PlatformPersonDto {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

export interface PlatformStaffDto {
  userId: string;
  person: PlatformPersonDto;
  status: PlatformStaffStatus;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  suspendedAt: string | null;
  roles: PlatformStaffRoleDto[];
}

export interface PlatformMeDto {
  userId: string;
  person: PlatformPersonDto;
  roles: PlatformRoleKey[];
  capabilities: PlatformCapability[];
  /** Окно sudo (null — подтверждения нет) */
  sudoUntil: string | null;
  sessionExpiresAt: string;
  policy: PlatformPolicyDto;
}

export type PlatformAuthStartResponse = VerifyStartResponse;

export interface PlatformLoginResponse {
  accessToken: string;
  expiresAt: string;
}

export interface PlatformStepUpResponse {
  sudoUntil: string;
}

// ---- Политика ----

export interface PlatformPolicyDto {
  dualControlEnabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// ---- Команды ----

/** Декларация команды глазами клиента (без `execute`). Схема входа — JSON Schema. */
export interface PlatformCommandDto {
  key: string;
  version: number;
  group: PlatformCommandGroup;
  titleKey: string;
  descriptionKey: string | null;
  capability: PlatformCapability;
  risk: PlatformRisk;
  dualControl: boolean;
  stepUp: boolean;
  /** Причина обязательна (risk ≥ high либо объявлено паспортом: раскрытие PII) */
  reasonRequired: boolean;
  dryRun: boolean;
  /** В карточках каких сущностей команда показывается (пусто — общая) */
  entities: PlatformEntity[];
  inputSchema: Record<string, unknown>;
}

export type PlatformCommandRunStatus = 'ok' | 'pending';

export interface PlatformCommandResultDto {
  status: PlatformCommandRunStatus;
  auditId: string | null;
  /** Заявка four-eyes (при `pending`) */
  requestId: string | null;
  result: unknown;
  before: unknown;
  after: unknown;
  /** Повтор идемпотентного ключа — отдан прежний результат */
  replayed: boolean;
}

export interface PlatformCommandPreviewDto {
  before: unknown;
  after: unknown;
  result: unknown;
}

// ---- Аудит ----

export interface PlatformAuditEntryDto {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actor: PlatformPersonDto | null;
  actorRolesSnapshot: PlatformRoleKey[];
  onBehalfOfId: string | null;
  sessionId: string | null;
  requestId: string | null;
  commandKey: string;
  commandVersion: number;
  input: unknown;
  targetType: string | null;
  targetId: string | null;
  targetWorkspaceId: string | null;
  before: unknown;
  after: unknown;
  outcome: PlatformAuditOutcome;
  errorCode: string | null;
  readOnly: boolean;
  risk: PlatformRisk;
  reason: string | null;
  ticketRef: string | null;
  approvalId: string | null;
  stepUpAt: string | null;
  idempotencyKey: string | null;
  dryRun: boolean;
  ip: string | null;
  userAgent: string | null;
  durationMs: number;
}

export type PlatformAuditPageDto = CursorPage<PlatformAuditEntryDto>;

export interface PlatformAccessLogDto {
  id: string;
  actorId: string;
  kind: PlatformAccessKind;
  targetType: string | null;
  targetId: string | null;
  fields: string[] | null;
  requestId: string | null;
  occurredAt: string;
}

// ---- Поиск и карточка 360 ----

export interface PlatformUserHitDto {
  entity: 'user';
  id: string;
  person: PlatformPersonDto;
  /** Маска: раскрытие — командой `platform.pii.reveal` */
  phoneMasked: string | null;
  isStaff: boolean;
  deletedAt: string | null;
}

export interface PlatformWorkspaceHitDto {
  entity: 'workspace';
  id: string;
  name: string;
  logo: string | null;
  binMasked: string | null;
  isActive: boolean;
  ownerId: string;
}

export type PlatformLookupHitDto = PlatformUserHitDto | PlatformWorkspaceHitDto;

export interface PlatformLookupResponseDto {
  query: ParsedPlatformQuery;
  users: PlatformUserHitDto[];
  workspaces: PlatformWorkspaceHitDto[];
}

export interface PlatformPanelRefDto {
  key: string;
  titleKey: string;
  order: number;
  /** Грузить сразу (первые панели) или по раскрытию */
  eager: boolean;
}

export interface PlatformEntityDto {
  entity: PlatformEntity;
  id: string;
  header: PlatformUserHitDto | PlatformWorkspaceHitDto;
  /** Чипы состояния (ключи каталога кабинета: `platform.chips.<key>`) */
  chips: Array<{ key: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> }>;
  panels: PlatformPanelRefDto[];
  /** Команды, доступные актору для этой сущности */
  commands: PlatformCommandDto[];
}

export interface PlatformPanelDataDto {
  key: string;
  data: unknown;
  loadedAt: string;
}

export interface PlatformPiiRevealResultDto {
  entity: PlatformEntity;
  id: string;
  fields: Record<string, string | null>;
}

// ---- Заявки four-eyes ----

export interface PlatformRequestDto {
  id: string;
  commandKey: string;
  commandVersion: number;
  titleKey: string;
  risk: PlatformRisk;
  input: unknown;
  targetType: string | null;
  targetId: string | null;
  actorId: string;
  actor: PlatformPersonDto | null;
  reason: string | null;
  status: PlatformRequestStatus;
  approvalId: string | null;
  /** Шаг согласования, который решает одобряющий (null — уже закрыт) */
  stepId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  executedAuditId: string | null;
  errorCode: string | null;
  createdAt: string;
  /** Могу ли я решить (не автор, держу `.approve`, заявка ждёт) */
  canDecide: boolean;
}

export type PlatformRequestsPageDto = CursorPage<PlatformRequestDto>;
