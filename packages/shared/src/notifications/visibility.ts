import { defineNotifications } from './types';

/**
 * Правила видимости (core/visibility). Адресатов решает продюсер (движок видимости):
 * - `visibility.reveal.notice` — СУБЪЕКТУ: его данные раскрыли (по тумблеру политики
 *   организации; без тумблера строка есть только в «Моих данных» журнала — без push);
 * - `visibility.policy.published` — владельцу и админам: политика опубликована;
 * - `visibility.reveal.paused` — владельцу и админам: детекция массового раскрытия
 *   остановила раскрытия человеку до их решения.
 * Payload — только коды и id: ни значений полей, ни имён полей ПДн (страж `check:visibility`).
 */
export const VISIBILITY_NOTIFICATIONS = defineNotifications({
  'visibility.reveal.notice': { service: 'visibility', priority: 'normal', icon: 'eye', contexts: 'workspace', collapse: 'type' },
  'visibility.policy.published': { service: 'visibility', priority: 'low', icon: 'shield', contexts: 'workspace', collapse: 'type' },
  'visibility.reveal.paused': { service: 'visibility', priority: 'high', icon: 'warning', contexts: 'workspace', collapse: 'ref' },
});
