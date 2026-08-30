/**
 * Единственные две двери наружу из apps/api. Голый `fetch` запрещён линтером
 * (`eslint.config.mjs`), исключение — только внутренности самих дверей.
 *
 *  - `safeFetch` — адрес ИЗ ДАННЫХ (нода Процессов, настройка организации, ввод
 *    человека): SSRF-щит, ручные редиректы, срезание кредов при смене хоста.
 *  - `trustedFetch` — адрес ИЗ .env (сидекары платформы): щита нет намеренно
 *    (их адреса приватны по построению), таймаут обязателен по сигнатуре.
 *
 * Выбор двери = ответ на один вопрос: «кто выбрал эту строку — оператор или
 * пользователь?». Оператор → trustedFetch, пользователь → safeFetch.
 *
 * ⚠️ `assertPublicUrlShallow` дверью НЕ является и защитой сама по себе тоже: она не
 * резолвит имя хоста. Связка «проверил ею + позвал `trustedFetch`» — это SSRF, а не
 * защита; адрес из данных идёт в `safeFetch`, и точка.
 */
export { safeFetch, fetchJson, assertPublicUrlShallow } from './safe-fetch';
export { trustedFetch } from './trusted-fetch';
export type { TrustedFetchOptions, TrustedOrigin } from './trusted-fetch';
