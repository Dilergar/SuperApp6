import type { Locale } from '../constants/i18n';
import type {
  ConsentActorRole,
  ConsentChannel,
  ConsentDocumentKey,
  ConsentMode,
  ConsentRevokeReason,
  ConsentSubjectType,
  ConsentVersionStatus,
} from '../consents/registry';
import type { ConsentBundleKey } from '../consents/bundles';
import type { PdBasis, PdFieldCode, PdRecipientKey } from '../consents/recipients';
import type { PdActionType, PdIncidentEventType, PdIncidentKind, PdIncidentStatus, PdPurpose } from '../consents/pd-actions';

// ============================================================
// core/consents — формы провода API ↔ клиенты
// ============================================================

/** Текст на трёх языках: версия документа = комплект kk + ru + en. */
export type ConsentLocalizedText = Record<Locale, string>;

/** Ссылка на версию документа (пакет, архив, «что ждёт принятия»). */
export interface ConsentVersionRefDto {
  documentKey: ConsentDocumentKey;
  versionId: string;
  version: number;
  status: ConsentVersionStatus;
  /** Существенная версия поднимает шлюз; несущественная (опечатки, реквизиты) — нет */
  material: boolean;
  effectiveFrom: string;
  publishedAt: string | null;
}

/** Документ целиком на одном языке — то, что человек читает и принимает. */
export interface ConsentDocumentDto extends ConsentVersionRefDto {
  /** Язык отданного текста */
  locale: Locale;
  /** «Коротко о главном» (markdown) */
  summary: string;
  /** Полный текст (markdown) */
  body: string;
  /** «Что изменилось» относительно прошлой версии; у первой версии — null */
  changeSummary: string | null;
  /** sha256 показанного текста на этом языке — уходит в запись приёмки */
  contentHash: string;
  /** Хэш комплекта трёх языков + цепочка с прошлой версией */
  manifestHash: string;
  /** Версия действует сейчас (а не ждёт даты вступления и не заменена) */
  isCurrent: boolean;
  /** Версия заверена ЭЦП руководителя оператора */
  attested: boolean;
}

export interface ConsentBundleDto {
  bundleKey: ConsentBundleKey;
  subject: ConsentSubjectType;
  /** Обязательные документы — одна галочка на все */
  documents: ConsentVersionRefDto[];
  /** Необязательные — отдельные галочки */
  optional: ConsentVersionRefDto[];
}

/** Документ, ждущий принятия. */
export interface ConsentPendingItemDto extends ConsentVersionRefDto {
  /** Какую версию субъект принимал раньше (null — никакую) */
  acceptedVersion: number | null;
}

export interface ConsentPendingWorkspaceDto {
  workspaceId: string;
  workspaceName: string;
  /** Принять от имени организации может только владелец */
  canAccept: boolean;
  /** Дата вступления прошла: управленческие действия владельца закрыты */
  blocking: ConsentPendingItemDto[];
  upcoming: ConsentPendingItemDto[];
}

export interface ConsentPendingDto {
  /** Дата вступления прошла — блокирующий экран */
  blocking: ConsentPendingItemDto[];
  /** Опубликовано, ещё не действует — баннер «принять заранее» */
  upcoming: ConsentPendingItemDto[];
  workspaces: ConsentPendingWorkspaceDto[];
}

/**
 * Состояние согласия в разделе «Мои данные»:
 *  - `accepted` — принята действующая версия; `outdated` — принята прошлая версия;
 *  - `declined` — отозвано / отказ; `none` — не принималось (opt-in);
 *  - `default_on` — действует по умолчанию (opt-out, человек ничего не выбирал).
 */
export type ConsentStateStatus = 'accepted' | 'outdated' | 'declined' | 'none' | 'default_on';

export interface ConsentStateItemDto {
  documentKey: ConsentDocumentKey;
  mode: ConsentMode;
  required: boolean;
  revocable: boolean;
  status: ConsentStateStatus;
  acceptanceId: string | null;
  acceptedVersion: number | null;
  acceptedAt: string | null;
  currentVersion: number | null;
  currentVersionId: string | null;
}

export interface ConsentHistoryItemDto {
  id: string;
  documentKey: ConsentDocumentKey;
  version: number;
  locale: Locale;
  actorRole: ConsentActorRole;
  channel: ConsentChannel;
  bundleKey: ConsentBundleKey | null;
  acceptedAt: string;
  revokedAt: string | null;
  revokedReason: ConsentRevokeReason | null;
}

/**
 * Персональный «Лист согласия» — 8 реквизитов ЗоПД ст. 8 п. 4. Форма машинная:
 * слова подставляет клиент из каталога, имена получателей и реквизиты — собственные.
 */
export interface ConsentReceiptDto {
  acceptanceId: string;
  documentKey: ConsentDocumentKey;
  version: number;
  locale: Locale;
  contentHash: string;
  manifestHash: string;
  signatureKid: string;
  /** Подпись платформы под версией проверена в момент выдачи листа */
  signatureValid: boolean;
  acceptedAt: string;
  revokedAt: string | null;
  channel: ConsentChannel;
  actorRole: ConsentActorRole;
  /** 1. Оператор: наименование, БИН, адрес */
  operator: { legalName: string; bin: string; address: string; privacyEmail: string };
  /** 2. Субъект: ФИО (и тот, кто принял за него, если это не он сам) */
  subject: { fullName: string; actorFullName: string | null };
  /** 3. Срок: до удаления аккаунта / отзыва (`until`), затем сроки хранения по закону */
  term: { until: 'account_deletion' | 'revocation' };
  /** 4. Передача третьим лицам внутри РК */
  thirdParties: Array<{ key: PdRecipientKey; name: string; fields: PdFieldCode[] }>;
  /** 5. Трансграничная передача */
  crossBorder: Array<{ key: PdRecipientKey; name: string; country: string | null; fields: PdFieldCode[] }>;
  /** 6. Распространение в общедоступных источниках — только по действию самого человека */
  publication: boolean;
  /** 7. Перечень собираемых данных */
  dataFields: PdFieldCode[];
}

/** Строка раздела «Кому передавались мои данные» (из `PdActionRecord`). */
export interface PdTransferDto {
  id: string;
  actionType: PdActionType;
  recipientKey: PdRecipientKey | null;
  recipientName: string | null;
  crossBorder: boolean;
  country: string | null;
  basis: PdBasis;
  fields: PdFieldCode[];
  purpose: PdPurpose;
  occurredAt: string;
}

/** Результат приёмки. */
export interface ConsentAcceptResultDto {
  accepted: Array<{ acceptanceId: string; documentKey: ConsentDocumentKey; version: number }>;
}

/** Причины, по которым аккаунт нельзя удалить прямо сейчас (мотивированный отказ, ЗоПД ст. 8 п. 7). */
export type AccountDeletionBlockerCode = 'sole_owner' | 'open_escrow' | 'debt';

export interface AccountDeletionBlockerDto {
  code: AccountDeletionBlockerCode;
  /** Организации-причины (`sole_owner`) */
  workspaces?: Array<{ id: string; name: string; members: number }>;
  /** Сколько живых сделок/долгов */
  count?: number;
}

export interface AccountDeletionBlockersDto {
  canDelete: boolean;
  blockers: AccountDeletionBlockerDto[];
  graceDays: number;
  /** Требуется ли SMS-код (в dev/test подтверждение номера может быть выключено) */
  verifyRequired: boolean;
}

// ---- Кабинет платформы ----

export interface PdIncidentEventDto {
  id: string;
  type: PdIncidentEventType;
  note: string | null;
  actorUserId: string | null;
  occurredAt: string;
}

export interface PdIncidentDto {
  id: string;
  kind: PdIncidentKind;
  status: PdIncidentStatus;
  scope: string;
  summary: string;
  affectedEstimate: number | null;
  detectedAt: string;
  notifyDeadlineAt: string;
  authorityNotifiedAt: string | null;
  subjectsNotifiedAt: string | null;
  closedAt: string | null;
  /** Дедлайн уведомления органа пропущен */
  overdue: boolean;
  events: PdIncidentEventDto[];
}

/** Строка версии в кабинете: без текста, с признаками публикации. */
export interface PlatformConsentVersionDto extends ConsentVersionRefDto {
  urgentReason: string | null;
  signatureKid: string | null;
  attested: boolean;
  hasDraft: boolean;
}

/** Охват принятия действующей версии документа. */
export interface PlatformConsentCoverageDto {
  documentKey: ConsentDocumentKey;
  subject: ConsentSubjectType;
  currentVersion: number | null;
  accepted: number;
  population: number;
}

export interface PlatformConsentsDocumentsDto {
  versions: PlatformConsentVersionDto[];
  coverage: PlatformConsentCoverageDto[];
}
