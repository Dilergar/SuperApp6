// ============================================================
// Оператор (юрлицо платформы) — подстановки юридических текстов
// ============================================================
// Реквизиты публичны (они печатаются в оферте) и подставляются в тексты документов на
// месте `{{legalName}} {{bin}} {{address}} {{domain}} {{privacyEmail}} {{dpoTitle}}` В МОМЕНТ
// ПУБЛИКАЦИИ: опубликованная версия хранит уже готовый текст, и смена реквизитов
// не меняет задним числом то, что человек принял (новые реквизиты = новая версия).
//
// Здесь — только то, что не зависит от языка. Наименование, адрес и должность ответственного
// лица (должностью, не ФИО) пишутся по-разному на kk/ru/en — это слова для человека, и живут
// они в каталоге `consents.operator.*` (`CONSENT_OPERATOR_KEYS`); сервер берёт их на языке документа.

export const CONSENT_OPERATOR = {
  bin: '260940016516',
  domain: 'superapp6.com',
  privacyEmail: 'lawyer@superapp6.com',
} as const;

/** Ключи каталога языкозависимых реквизитов. */
export const CONSENT_OPERATOR_KEYS = {
  legalName: 'consents.operator.legalName',
  address: 'consents.operator.address',
  dpoTitle: 'consents.operator.dpoTitle',
} as const;

export const CONSENT_PLACEHOLDERS = ['legalName', 'bin', 'address', 'domain', 'privacyEmail', 'dpoTitle'] as const;
export type ConsentPlaceholder = (typeof CONSENT_PLACEHOLDERS)[number];
export type ConsentPlaceholderValues = Record<ConsentPlaceholder, string>;

/**
 * Подставить реквизиты в текст. Неизвестная подстановка — ошибка: опечатка в `{{…}}`
 * иначе ушла бы в опубликованный юридический текст буквально.
 */
export function fillConsentPlaceholders(text: string, values: ConsentPlaceholderValues): string {
  const map = values as Record<string, string>;
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    const v = map[name];
    if (v === undefined) throw new Error(`consents: unknown placeholder {{${name}}}`);
    return v;
  });
}
