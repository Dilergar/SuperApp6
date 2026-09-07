/**
 * Origin'ы веб-приложения — ОДИН список на трёх потребителей: CORS HTTP, CORS сокета
 * `/realtime` и `frame-ancestors` на выдаче байтов. Разъехавшись, они дают разные
 * симптомы («не грузится список» / «сокет не подключается» / «пустая рамка вместо
 * документа»), которые ищут в трёх разных местах.
 *
 * Прод-адрес берётся из `WEB_URL` в момент ЗАПРОСА, а не при импорте: декоратор
 * gateway вычисляется раньше, чем поднимается приложение.
 */

/** Адреса веба в разработке (127.0.0.1 — тот же веб вторым origin: две изолированные сессии). */
export const WEB_DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'] as const;

/** Expo dev-сервер мобильного клиента (этап 2). */
export const MOBILE_DEV_ORIGINS = ['http://localhost:8081'] as const;

/** Полный список разрешённых origin'ов: `WEB_URL` (прод) + адреса разработки. */
export function webOrigins(): string[] {
  const configured = (process.env.WEB_URL || '').trim().replace(/\/+$/, '');
  return [...new Set([...(configured ? [configured] : []), ...WEB_DEV_ORIGINS, ...MOBILE_DEV_ORIGINS])];
}

/** Запрос без Origin (не браузер, same-origin) не отвергаем — как и раньше при списке-массиве. */
export function isAllowedWebOrigin(origin?: string): boolean {
  return !origin || webOrigins().includes(origin);
}
