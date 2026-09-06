// ============================================================
// @superapp/i18n — слова платформы и правила их показа.
//
// Разделение с @superapp/shared несущее: shared — пакет ПРОВОДА (типы, Zod,
// реестры-константы), его тянет каждый клиент. Каталоги сообщений тянут только
// те, кто рисует текст (API и веб), поэтому они живут отдельным пакетом —
// иначе мобильный контракт типов тащил бы за собой словарь всех языков.
//
// Порядок сборки: shared → i18n → api-client → api/web.
// ============================================================

export {
  FALLBACK_CHAIN,
  REGION_PROFILE_KZ,
  HOME_LANGUAGE_COUNTRIES,
  regionProfileFor,
  DEFAULT_LOCALE,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
} from './config';
export type { RegionProfile, Locale } from './config';

export { negotiateLocale, coerceLocale, isLocale, countryFromHeaders, GEO_COUNTRY_HEADERS } from './resolve';
export type { NegotiateOptions } from './resolve';

export { NAMESPACES, CORE_NAMESPACES, isNamespace } from './namespaces';
export type { Namespace } from './namespaces';

export { loadMessages, loadAllMessages, pickNamespaces, MESSAGES } from './loader';
export type { Messages, MessageTree } from './loader';

export { createT, IntlErrorCode } from './translator';
export type { Translator, TranslationValues, IntlError } from './translator';

export {
  createFormatters,
  formatDate,
  formatTime,
  formatDateTime,
  formatTimeRange,
  formatDayKey,
  formatNumber,
  formatMoney,
  formatBytes,
} from './format';
export type { Formatters, FormatContext, DateStyle, NumberOptions, ByteUnits } from './format';

export { renderChatter, chatterFieldLabel } from './chatter';
export type {
  ChatterRaw,
  ChatterRawKind,
  ChatterChangeLike,
  ChatterEntryLike,
} from './chatter';
