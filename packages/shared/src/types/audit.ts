import type {
  AuditAlertResolution,
  AuditAlertStatus,
  AuditCategory,
  AuditClient,
  AuditDeviceClass,
  AuditOutcome,
  AuditSeverity,
  SessionRevokeReason,
} from '../audit/types';

// ============================================================
// core/audit (26-й) — формы провода API ↔ клиенты (веб, mobile, Кабинет, AI)
// ============================================================

/** Человек в событии — PersonChip на клиенте (лайт-карточка; удалённый — null). */
export interface AuditPersonDto {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

/**
 * Актор события — по проекции зрителя:
 * - человек → карточка (PersonChip); бот → BotChip по id;
 * - сотрудник платформы: платформе — карточка, остальным — `{kind:'platform'}` БЕЗ личности;
 * - система, гость, аноним, устройство — без личности.
 */
export type AuditActorDto =
  | { kind: 'user'; id: string; person: AuditPersonDto | null }
  /** Бот — BotChip: имя теневого аккаунта (архивный бот — null) */
  | { kind: 'bot'; id: string; name: string | null }
  | { kind: 'platform_staff'; id: string; person: AuditPersonDto | null }
  | { kind: 'platform' }
  /** Система — по поручению человека продукта (кадровое действие применил джоб), если он известен */
  | { kind: 'system'; onBehalfOf?: AuditPersonDto | null }
  | { kind: 'guest' }
  | { kind: 'anonymous' }
  | { kind: 'device'; id: string | null };

/** Где: страна (+ город при GeoIP). Полный IP человеку и организации не отдаётся никогда. */
export interface AuditLocationDto {
  country: string | null;
  city: string | null;
  /** Только платформе: сеть /24 (/48) */
  ipNet?: string | null;
}

export interface AuditDeviceDto {
  /** «Chrome · Windows» — человекочитаемо; сырой UA в списках не показывается */
  label: string | null;
  class: AuditDeviceClass | null;
}

/** Цель события: человек (PersonChip) либо сущность с подписью-снимком. */
export interface AuditTargetDto {
  type: string;
  id: string;
  /** Снимок подписи НЕ-человека (имя ключа, адрес вебхука без query) */
  label: string | null;
  /** Цель — человек: карточка */
  person?: AuditPersonDto | null;
}

/** Событие журнала безопасности в проекции зрителя. Текст — render-at-read в языке запроса. */
export interface SecurityEventDto {
  /** bigint строкой */
  id: string;
  /** uuid события — дедупликация во внешних системах */
  eventId: string;
  occurredAt: string;
  key: string;
  category: AuditCategory;
  severity: AuditSeverity;
  outcome: AuditOutcome;
  reasonCode: string | null;
  /** Операция (ключ команды Кабинета, действие ключа) */
  op: string | null;
  title: string;
  body: string | null;
  actor: AuditActorDto;
  /** Чья лента (платформе и организации — карточка) */
  subject: AuditPersonDto | null;
  workspaceId: string | null;
  target: AuditTargetDto | null;
  client: AuditClient | null;
  location: AuditLocationDto;
  device: AuditDeviceDto;
  /** Детали по проекции (платформе — все; остальным — без служебных снимков) */
  details: Record<string, unknown>;
  /** Можно оспорить («Это не я») — только в ленте человека */
  disputable: boolean;
  requestId: string | null;
  /** Событие-причина / квитанция / ключ (id строкой) */
  ref: { type: string; id: string } | null;
}

export interface SecurityEventPageDto {
  items: SecurityEventDto[];
  nextCursor: string | null;
  /** Окно, за которое показаны события (дни); null — без окна */
  windowDays: number | null;
}

/**
 * «Мои данные» журнала безопасности (`GET /users/me/security/export`, ЗоПД ст. 24): все события
 * ленты человека за весь срок хранения. Полный IP — только у событий, где действовал он сам (или
 * аноним на его аккаунт: неудачный вход, заморозка); адрес админа или сотрудника платформы,
 * действовавших над ним, — чужие данные и сюда не попадают.
 */
export interface SecurityMyDataExportDto {
  generatedAt: string;
  rows: Array<SecurityEventDto & { ip: string | null }>;
  /** Отдана новейшая часть (потолок строк за раз) */
  truncated: boolean;
}

/** Полный IP события — только платформе (отдельный запрос с записью `pii.read`). */
export interface SecurityEventIpDto {
  ip: string | null;
  ipNet: string | null;
  /** Псевдоним сети для поиска «все события с этого IP» */
  ipHmac: string | null;
}

// ---- Сессии и устройства человека ----

/** Сессия = семейство refresh-цепочки одного входа (строка ротируется на каждом refresh). */
export interface SecuritySessionDto {
  /** id семейства */
  id: string;
  device: AuditDeviceDto;
  deviceId: string | null;
  client: AuditClient | null;
  country: string | null;
  /** Начало семейства — момент входа */
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
  /** Подтверждена (step-up) либо доверенная по сроку; null — до подтверждения */
  confirmedAt: string | null;
  /** Когда станет доверенной сама (cooling), если не подтверждена */
  confirmAt: string | null;
  revokedAt: string | null;
  revokedReason: SessionRevokeReason | null;
}

export interface SecuritySessionsDto {
  active: SecuritySessionDto[];
  /** «Вышедшие устройства» — за 90 дней */
  ended: SecuritySessionDto[];
}

export interface UserDeviceDto {
  id: string;
  deviceId: string;
  label: string;
  /** Человек переименовал устройство (label — его) */
  renamed: boolean;
  class: AuditDeviceClass;
  platform: string | null;
  browser: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCountry: string | null;
  trustedAt: string | null;
  isCurrent: boolean;
  activeSessions: number;
}

/** Состояние «Это не я» после шага 1. */
export interface NotMeResultDto {
  sessionsRevoked: number;
  devicesForgotten: number;
  keysRevoked: number;
  googleDisconnected: boolean;
}

/** Настройки безопасности человека. */
export interface SecuritySettingsDto {
  sessionMaxIdleDays: number;
}

/** Плашка cooling текущей сессии. */
export interface SecurityCoolingDto {
  confirmed: boolean;
  /** Когда сессия станет доверенной сама */
  confirmAt: string | null;
}

// ---- Организация ----

export interface OrgSecurityOverviewDto {
  /** Окно журнала по тарифу (дни) */
  retentionDays: number;
  /** Экспорт открыт тарифом */
  canExport: boolean;
  /** Стрим открыт тарифом */
  canStream: boolean;
}

/** Ответ на заказ выгрузки: джоб поставлен, файл придёт уведомлением. */
export interface AuditExportAcceptedDto {
  jobQueued: true;
}

// ---- Кабинет платформы ----

export interface SecurityAlertDto {
  id: string;
  kind: string;
  severity: AuditSeverity;
  status: AuditAlertStatus;
  subject: AuditPersonDto | null;
  subjectUserId: string | null;
  workspaceId: string | null;
  /** Псевдоним сети (без IP) */
  ipHmac: string | null;
  /** id событий-улик */
  evidence: string[];
  /** Сколько раз правило сработало, пока тревога открыта */
  hits: number;
  assigneeId: string | null;
  resolution: AuditAlertResolution | null;
  openedAt: string;
  closedAt: string | null;
}

export interface SecurityAlertPageDto {
  items: SecurityAlertDto[];
  nextCursor: string | null;
}

/** Консоль: псевдонимы сети по IP — фильтр `ipHmac` ленты (IP в адрес не кладётся). */
export interface SecurityNetworkLookupDto {
  pseudonyms: string[];
}

/** Результат раскрытия IP события командой Кабинета (в журнал команд не пишется — S7). */
export interface SecurityEventRevealIpDto {
  eventId: string;
  ip: string | null;
  ipNet: string | null;
  /** Псевдонимы сети — ссылка «Все события с этого IP» */
  pseudonyms: string[];
}

/** Выгрузка журнала Кабинетом — строка списка «Мои выгрузки» (вкладка «Целостность»). */
export interface PlatformSecurityExportDto {
  fileId: string;
  name: string;
  size: number;
  createdAt: string;
}

/** Панель `user.security` карточки 360 Кабинета. */
export interface PlatformUserSecurityPanelDto {
  frozenAt: string | null;
  /** Блокировка входа до (перебор пароля) */
  lockedUntil: string | null;
  activeSessions: number;
  devices: number;
  openAlerts: SecurityAlertDto[];
  recent: SecurityEventDto[];
}

/** Панель `workspace.security` карточки 360 Кабинета. */
export interface PlatformWorkspaceSecurityPanelDto {
  retentionDays: number;
  canExport: boolean;
  canStream: boolean;
  openAlerts: SecurityAlertDto[];
  recent: SecurityEventDto[];
}

export interface SecurityDigestDto {
  id: string;
  firstAt: string | null;
  lastAt: string | null;
  count: number;
  /** Корень Меркла (hex, префикс для показа — на клиенте) */
  merkleRoot: string;
  kid: string;
  signedAt: string;
  exportedAt: string | null;
  verifiedAt: string | null;
  verifyOk: boolean | null;
}

export interface SecurityDigestVerifyDto {
  digests: number;
  rows: number;
  ok: boolean;
  mismatched: Array<{ digestId: string; reason: string }>;
}

export interface SecurityPartitionDto {
  name: string;
  from: string;
  to: string;
  /** in_db | archived | dropped */
  status: 'in_db' | 'archived' | 'dropped';
  rows: number | null;
  archivedAt: string | null;
  manifestKey: string | null;
}

/**
 * Манифест архива месяца, прочитанный из хранилища и проверенный: подпись сверяется с
 * подписью, записанной в базе при выгрузке (подмена файла в хранилище — `signatureOk: false`).
 */
export interface SecurityPartitionManifestDto {
  partition: string;
  format: string;
  from: string;
  to: string;
  rows: number;
  bytes: number;
  sha256: string;
  merkleRoot: string;
  objectKey: string;
  kid: string;
  archivedAt: string;
  droppedAt: string | null;
  /** Подпись платформы над манифестом верна (архивная проверка ключа `audit`) */
  signatureOk: boolean;
  /** Строк, байт и хеш манифеста совпадают со строкой архива в базе */
  matchesRecord: boolean;
}

/** Сводка очереди тревог — счётчик вкладки «Тревоги» Кабинета. */
export interface SecurityAlertSummaryDto {
  open: number;
  ack: number;
  /** Из них critical (открытые и в работе) */
  critical: number;
}

// ---- Сокет (core/realtime) ----

/** `security:changed` в личной комнате: раздел «Безопасность» перечитывает сессии или ленту. */
export interface WsSecurityChanged {
  kind: 'event' | 'session';
  /** id события (bigint строкой) */
  id: string | null;
}

// ---- Стрим наружу (core/webhooks) ----

/**
 * Полезная нагрузка вебхука `security.<category>` — OCSF-маппинг без IP, UA и имён людей
 * (только id): стрим в SIEM организации не становится передачей ПДн третьему лицу.
 */
export interface SecurityWebhookPayload {
  /** Версия формы полезной нагрузки */
  schema: 1;
  eventId: string;
  key: string;
  category: AuditCategory;
  occurredAt: string;
  severity: AuditSeverity;
  outcome: AuditOutcome;
  /** `onBehalfOfId` — у системного актора: человек продукта, по чьему действию сработала система */
  actor: { kind: string; id: string | null; onBehalfOfId?: string | null };
  subjectUserId: string | null;
  target: { type: string; id: string } | null;
  country: string | null;
  ocsf: Record<string, unknown>;
}
