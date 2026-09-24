import { z } from 'zod';
import { defineAnalyticsEvents, propCode, propCount } from './types';

// ============================================================
// Правила видимости (core/visibility) — adoption настройки и раскрытий.
// Свойства — только коды: тип записи, группа полей, исход. Ни значений, ни id людей:
// аналитика отвечает «пользуются ли», а «кто что раскрыл» — дело журнала безопасности.
// ============================================================

export const VISIBILITY_ANALYTICS_EVENTS = defineAnalyticsEvents({
  /** Организация опубликовала политику (факт сервера, из транзакции публикации) */
  'visibility.policy.published': {
    service: 'visibility',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ recordType: propCode(64), rules: propCount(), fromPreset: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
  /** Раскрытие запрошено (факт сервера): итог — `ok` / код отказа */
  'visibility.reveal.requested': {
    service: 'visibility',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ recordType: propCode(64), fields: propCount(), result: propCode(32) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Зритель увидел строку «часть данных скрыта правилами» (клиент) */
  'visibility.field.hidden_seen': {
    service: 'visibility',
    source: 'client',
    class: 'product',
    qualifying: false,
    props: z.object({ recordType: propCode(64), hidden: propCount() }).strict(),
    version: 1,
    status: 'live',
  },
  /** Человек поменял «кто видит» поле своей карточки (факт сервера) */
  'visibility.personal.changed': {
    service: 'visibility',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ fields: propCount(), widened: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
});
