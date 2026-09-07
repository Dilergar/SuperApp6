import { defineNotifications } from './types';

/**
 * Гостевые ссылки наружу (core/share-links). «Вашу ссылку открыли» — FYI:
 * схлопывается по ссылке («открыли ×12») и троттлится (20 событий в сутки на
 * ссылку — дальше тишина). Заменяет самодельный тип `share.link.opened.muted`.
 * `ref` = ссылка (`share_link`).
 */
export const SHARE_NOTIFICATIONS = defineNotifications({
  'share.link.opened': {
    service: 'share',
    priority: 'low',
    icon: 'link',
    contexts: 'both',
    collapse: 'ref',
    throttle: { windowSec: 24 * 3600, max: 20 },
  },
});
