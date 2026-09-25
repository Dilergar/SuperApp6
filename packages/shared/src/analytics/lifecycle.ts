import { z } from 'zod';
import { defineAnalyticsEvents, propCode, propCount } from './types';

// ============================================================
// Жизненный цикл данных (core/lifecycle) — adoption сроков хранения и таймеров чатов.
// Свойства — коды и числа: класс данных, срок в сутках (0 — «вечно» / «выкл»), вид чата.
// Ни id людей, ни названий: «пользуются ли», а не «кто».
// ============================================================

export const LIFECYCLE_ANALYTICS_EVENTS = defineAnalyticsEvents({
  /** Организация сменила срок хранения класса данных (факт сервера, из транзакции сохранения) */
  'lifecycle.retention.changed': {
    service: 'lifecycle',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ dataClass: propCode(32), days: propCount(), shortened: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
  /** Участник включил, сменил или выключил таймер автоудаления в чате (факт сервера) */
  'lifecycle.timer.set': {
    service: 'lifecycle',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ days: propCount(), chatType: propCode(16), workspace: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
  /** Заказана выгрузка данных целиком: человек — своих, владелец — организации (факт сервера) */
  'lifecycle.export.requested': {
    service: 'lifecycle',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ subjectType: propCode(16) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Выдана ссылка на часть готовой выгрузки (факт сервера): номер скачивания части */
  'lifecycle.export.downloaded': {
    service: 'lifecycle',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ subjectType: propCode(16), download: propCount() }).strict(),
    version: 1,
    status: 'live',
  },
});
