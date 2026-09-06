import { SOURCE_LOCALE, type Locale } from '@superapp/shared';
import { FALLBACK_CHAIN } from './config';
import { CORE_NAMESPACES, NAMESPACES, type Namespace } from './namespaces';
import { MESSAGES, type MessageTree } from './messages';

/** Плоское дерево сообщений: `{ common: {...}, errors: {...} }` */
export type Messages = Record<string, MessageTree>;

/**
 * Глубокое слияние: значения `over` побеждают, но КЛЮЧИ `base` остаются.
 * Именно так работает запасной язык — недостающая фраза берётся из `en`.
 * Мутации нет: результат — новое дерево (кэш отдаёт его наружу).
 */
function deepMerge(base: MessageTree, over: MessageTree): MessageTree {
  const out: MessageTree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] =
      typeof value === 'object' && value !== null && typeof prev === 'object' && prev !== null
        ? deepMerge(prev, value)
        : value;
  }
  return out;
}

// Кэш на процесс: слияние с фолбэком делается один раз на пару (локаль, набор
// неймспейсов). Каталоги неизменяемы, поэтому инвалидация не нужна.
const cache = new Map<string, Messages>();

/**
 * Каталоги языка `locale` для перечисленных неймспейсов.
 * `common` и `shell` добавляются всегда (правило страницы: свои + общие).
 *
 * Слияние идёт СПРАВА НАЛЕВО по цепочке фолбэков: сначала кладём `en`, поверх —
 * язык зрителя. Страж `check:i18n` требует 100 % паритета en/kk/ru, поэтому
 * сегодня слияние ничего не добавляет; оно существует для НОВОГО языка, который
 * ещё переводится, — и для него же не даёт странице сломаться на полуслове.
 */
export function loadMessages(
  locale: Locale,
  namespaces: readonly Namespace[] = NAMESPACES,
): Messages {
  const wanted = [...new Set([...CORE_NAMESPACES, ...namespaces])].sort();
  const key = `${locale}|${wanted.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const chain: Locale[] = [...FALLBACK_CHAIN[locale]].reverse();
  const out: Messages = {};
  for (const ns of wanted) {
    let tree: MessageTree = {};
    for (const step of chain) tree = deepMerge(tree, MESSAGES[step][ns]);
    out[ns] = deepMerge(tree, MESSAGES[locale][ns]);
  }
  cache.set(key, out);
  return out;
}

/** Все каталоги языка — серверный путь (API держит их в памяти целиком). */
export function loadAllMessages(locale: Locale): Messages {
  return loadMessages(locale, NAMESPACES);
}

/**
 * Срез каталогов под клиентский провайдер: `pick(messages, ['common','shell','tasks'])`.
 * Именно он решает, какой объём каталога уедет в браузер RSC-пейлоадом.
 */
export function pickNamespaces(messages: Messages, namespaces: readonly string[]): Messages {
  const out: Messages = {};
  for (const ns of new Set([...CORE_NAMESPACES, ...namespaces])) {
    const tree = messages[ns];
    if (tree) out[ns] = tree;
  }
  return out;
}

export { MESSAGES, SOURCE_LOCALE };
export type { MessageTree, Namespace };
