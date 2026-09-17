import type {
  ApiKeyKind,
  ApiKeyRevokeReason,
  ApiKeyStatus,
  BotFrozenReason,
  BotRank,
  BotStatus,
  KeyPurpose,
  KeyRegistryKind,
  KeyScopeService,
  KeyScopes,
  KeyVersionState,
  KeysProviderKind,
  SigningAudience,
  WebhookDeliveryStatus,
  WebhookDisabledReason,
  WebhookEndpointStatus,
  WebhookEventKey,
  WebhookSigning,
} from '../keys';
import type { CursorPage } from './common';

// ============================================================
// core/keys + core/webhooks — формы провода (обе стороны: API ↔ веб/mobile/кабинет)
// ============================================================

/** Версия ключа в keystore (панель кабинета, дев-полигон). Материала здесь нет никогда. */
export interface KeyVersionDto {
  kid: string;
  version: number;
  state: KeyVersionState;
  /** Отпечаток корня, которым обёрнут материал (ротация корня меняет его у всех) */
  rootKid: string;
  createdAt: string;
  activatedAt: string | null;
  deactivatedAt: string | null;
  destroyScheduledAt: string | null;
  destroyedAt: string | null;
}

export interface CryptoKeyDto {
  id: string;
  scope: string;
  purpose: KeyPurpose;
  name: string;
  algorithm: string;
  provider: KeysProviderKind;
  primaryKid: string | null;
  createdAt: string;
  versions: KeyVersionDto[];
}

/** Публичный ключ JWKS (RFC 7517, OKP/Ed25519). */
export interface JwkDto {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string;
  use: 'sig';
  alg: 'EdDSA';
}

export interface JwksDto {
  keys: JwkDto[];
}

/** Состояние движка для дев-полигона и панели. */
export interface KeysStatusDto {
  provider: KeysProviderKind;
  rootKid: string;
  signing: Array<{ audience: SigningAudience; primaryKid: string | null; versions: number }>;
  mac: Array<{ name: string; primaryKid: string | null; versions: number }>;
  kekCount: number;
  legacyHs256Until: string | null;
}

// ---- Боты ----

export interface BotDto {
  id: string;
  workspaceId: string;
  /** Теневая строка `users` бота — его id как актора в хронике, задачах, правах */
  userId: string;
  name: string;
  glyph: string | null;
  status: BotStatus;
  frozenReason: BotFrozenReason | null;
  frozenAt: string | null;
  rank: BotRank;
  responsibleUserId: string | null;
  purpose: string;
  scopes: KeyScopes;
  ipAllowlist: string[];
  createdById: string;
  createdAt: string;
  archivedAt: string | null;
  /** Живых ключей у бота */
  liveKeys: number;
}

/** Карточка бота: ключи + люди (ответственный, создатель) — обогащает сервер. */
export interface BotDetailsDto extends BotDto {
  keys: ApiKeyDto[];
  responsible: KeyActorLiteDto | null;
  createdBy: KeyActorLiteDto | null;
}

// ---- Ключи API ----

export interface ApiKeyDto {
  id: string;
  kind: Extract<ApiKeyKind, 'bot' | 'pat'>;
  botId: string | null;
  userId: string | null;
  /** null у личного ключа для собственных данных человека */
  workspaceId: string | null;
  familyId: string;
  name: string;
  purpose: string;
  /** Показываемая часть: `sa6_bot_live_ab12` … `…last4` */
  prefix: string;
  last4: string;
  scopes: KeyScopes;
  ipAllowlist: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Страна последнего обращения (ISO-код из гео-заголовка CDN); null без CDN */
  lastUsedLocation: string | null;
  /** IP последнего обращения — владельцу и админам (как в GitHub «last used from») */
  lastUsedIp: string | null;
  useCount: number;
  revokedAt: string | null;
  revokedReason: ApiKeyRevokeReason | null;
  rotatedFromId: string | null;
  /** Старый секрет после ротации живёт до этого момента */
  graceUntil: string | null;
  /** Заметка «где сохранил» */
  storedHint: string | null;
  createdById: string;
  createdAt: string;
  /** Вычисляется сервером: active | expiring | expired | revoked | frozen */
  status: ApiKeyStatus;
}

/** Ответ создания/ротации — секрет ОДИН раз. */
export interface ApiKeyCreatedDto {
  key: ApiKeyDto;
  secret: string;
}

export interface BotCreatedDto {
  bot: BotDto;
  key: ApiKeyDto;
  secret: string;
}

// ---- Реестр ключей организации ----

/** Лайт-профиль человека/бота для чипов реестра и журнала (батч-обогащение страницы). */
export interface KeyActorLiteDto {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  kind: 'person' | 'bot';
}

export interface KeyRegistryHolderDto {
  /** bot → бот-чип; personal → PersonChip; webhook → адрес */
  kind: KeyRegistryKind;
  id: string;
  name: string;
  glyph?: string | null;
  /** Для personal — карточка человека (PersonChip); заполняет сервер */
  person?: KeyActorLiteDto | null;
}

export interface KeyRegistryRowDto {
  kind: KeyRegistryKind;
  id: string;
  name: string;
  holder: KeyRegistryHolderDto;
  createdById: string | null;
  /** Кто создал — карточка человека (заполняет сервер) */
  createdBy: KeyActorLiteDto | null;
  createdAt: string;
  purpose: string;
  /** Сводка «3 сервиса» + сами скоупы для раскрытия */
  scopeCount: number;
  scopes: KeyScopes;
  status: ApiKeyStatus | WebhookEndpointStatus;
  /** Для статуса `expiring` — сколько дней осталось */
  expiresInDays: number | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Страна последнего обращения (гео-заголовок CDN) */
  lastUsedLocation: string | null;
  /** IP последнего обращения (у вебхуков — null) */
  lastUsedIp: string | null;
  /** Бот заморожен (creator_left | owner | platform) */
  frozenReason: BotFrozenReason | null;
  botId: string | null;
}

export type KeyRegistryPage = CursorPage<KeyRegistryRowDto>;

/** Значок в шапке организации: сколько ботов ждут решения владельца. */
export interface KeysPendingDto {
  frozenBots: number;
}

export interface KeyAuditEntryDto {
  id: string;
  occurredAt: string;
  actorId: string | null;
  /** user | bot | system | platform */
  actorKind: string;
  action: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
}

export interface KeyAuditPage extends CursorPage<KeyAuditEntryDto> {
  /** Акторы страницы по id — PersonChip/BotChip в журнале */
  actors: Record<string, KeyActorLiteDto>;
}

export interface WorkspaceKeyPolicyDto {
  workspaceId: string;
  /** Потолок срока личных ключей для данных организации, дней (≤ 365) */
  maxPatDays: number;
  /** Потолок срока ключей ботов, дней; null — бессрочно разрешено владельцу с IP-списком */
  maxBotKeyDays: number | null;
  requireIpAllowlist: boolean;
}

/** Матрица прав в UI: строки — сервисы, доступные носителю. */
export interface KeyScopeMatrixDto {
  /** `bot: false` — сервис «между людьми», ботам закрыт (только личные ключи) */
  services: Array<{ service: KeyScopeService; bot: boolean; botMax: 'read' | 'write' }>;
}

/** Окно «сильного подтверждения» для управления ключами. */
export interface KeysStepUpStatusDto {
  until: string | null;
}

/** Validity-check ключа без раскрытия владельца. */
export interface ApiKeyVerifyDto {
  valid: boolean;
  kind: ApiKeyKind | null;
}

// ---- Исходящие вебхуки ----

export interface WebhookEndpointDto {
  id: string;
  workspaceId: string;
  url: string;
  events: WebhookEventKey[];
  signing: WebhookSigning;
  status: WebhookEndpointStatus;
  /** Подряд провалов (обнуляется успешной доставкой) */
  failures: number;
  disabledAt: string | null;
  disabledReason: WebhookDisabledReason | null;
  /** Ротация: старый секрет живёт до этого момента */
  prevSecretUntil: string | null;
  /** Публичный ключ Ed25519 (base64url) для signing=ed25519 */
  publicKey: string | null;
  createdById: string;
  createdAt: string;
  lastDeliveryAt: string | null;
}

export interface WebhookEndpointCreatedDto {
  endpoint: WebhookEndpointDto;
  /** Секрет подписи ОДИН раз (`sa6_whs_…`) */
  secret: string;
}

export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  eventKey: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export type WebhookDeliveryPage = CursorPage<WebhookDeliveryDto>;

/** Каталог событий вебхуков (`GET /webhooks/events`): по сервисам, с версией формы payload. */
export interface WebhookEventCatalogDto {
  services: Array<{ service: string; events: Array<{ key: WebhookEventKey; version: number }> }>;
}
