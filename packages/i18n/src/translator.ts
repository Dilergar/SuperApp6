import { createTranslator, IntlErrorCode, type IntlError } from 'use-intl/core';
import type { Locale } from '@superapp/shared';
import { loadAllMessages, loadMessages, type Messages } from './loader';
import type { Namespace } from './namespaces';

// ============================================================
// Переводчик СЕРВЕРНОЙ стороны (API, джобы, будущий mobile-бэкенд).
// Веб пользуется тем же движком через next-intl — каталоги общие.
// ============================================================

/** Значения для подстановки. Только примитивы: ICU не умеет объекты. */
export type TranslationValues = Record<string, string | number | boolean | Date>;

export interface Translator {
  /** Полный ключ с неймспейсом: `errors.db.notFound`, `notifications.task.assigned.title` */
  (key: string, values?: TranslationValues): string;
  /** Есть ли такой ключ (у уведомлений тело необязательно) */
  has(key: string): boolean;
  /** Сырая ICU-строка без подстановки — нужна, чтобы узнать её плейсхолдеры */
  raw(key: string): string | undefined;
  locale: Locale;
}

/** Один раз на ключ: иначе пропущенная фраза заливает лог на каждый запрос. */
const reportedOnce = new Set<string>();

function defaultOnError(locale: Locale, error: IntlError): void {
  // MISSING_MESSAGE ждём только у необязательных ключей (их спрашивают через
  // has()), поэтому сюда он попадает как настоящая дыра в каталоге.
  const key = `${locale}|${error.code}|${error.message}`;
  if (reportedOnce.has(key)) return;
  reportedOnce.add(key);
  // Пакет не знает про Logger NestJS: сюда он попадает и из браузера, и из
  // джоба, поэтому единственный общий канал — консоль.
  console.error(`[i18n] ${error.code}: ${error.message}`);
}

const ALL_PLACEHOLDERS = /\{\s*([A-Za-z0-9_]+)\s*[,}]/g;

/**
 * Создать переводчик языка. `namespaces` не задан → все каталоги (серверный путь).
 *
 * `onError` намеренно НЕ бросает: отсутствующая фраза не должна валить ответ API
 * (текст — не транзакция). Вместо этого она попадает в лог один раз и рендерится
 * своим ключом — так дыра видна и в проде, и в браузерной проверке.
 */
export function createT(
  locale: Locale,
  namespaces?: readonly Namespace[],
  options: { onError?(error: IntlError): void } = {},
): Translator {
  const messages: Messages = namespaces ? loadMessages(locale, namespaces) : loadAllMessages(locale);
  const onError = options.onError ?? ((e: IntlError) => defaultOnError(locale, e));
  const inner = createTranslator({
    locale,
    messages: messages as never,
    onError,
    getMessageFallback: ({ key }) => key,
  });

  const t = ((key: string, values?: TranslationValues) => {
    const raw = t.raw(key);
    // Пропущенный плейсхолдер в ICU — это ОШИБКА форматирования (весь текст
    // заменяется ключом), а старый движок `{{…}}` подставлял пустую строку.
    // Уведомления и хроника опираются на это поведение: часть плейсхолдеров —
    // необязательные суффиксы, которых в payload может не быть. Дозаполняем их
    // пустыми строками, чтобы фраза не рассыпалась из-за одного суффикса.
    let filled = values;
    if (typeof raw === 'string' && raw.includes('{')) {
      const needed = new Set<string>();
      ALL_PLACEHOLDERS.lastIndex = 0;
      for (let m = ALL_PLACEHOLDERS.exec(raw); m; m = ALL_PLACEHOLDERS.exec(raw)) needed.add(m[1]);
      if (needed.size) {
        filled = { ...(values ?? {}) };
        for (const name of needed) {
          const v = (filled as Record<string, unknown>)[name];
          if (v === undefined || v === null) (filled as Record<string, unknown>)[name] = '';
        }
      }
    }
    return inner(key as never, filled as never);
  }) as Translator;

  t.raw = (key: string) => {
    let node: unknown = messages;
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
  };
  t.has = (key: string) => t.raw(key) !== undefined;
  t.locale = locale;
  return t;
}

export { IntlErrorCode };
export type { IntlError };
