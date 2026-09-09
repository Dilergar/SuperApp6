import { REGION_PROFILE_KZ, SOURCE_LOCALE, type Locale } from '@superapp/i18n';
import type { I18nService } from './i18n.service';

/**
 * ЯЗЫК БУМАГИ ПО УМОЛЧАНИЮ — государственный язык рынка (профиль региона), а не
 * язык интерфейса и не язык источника: организация в Казахстане ведёт
 * документооборот на казахском, пока не решила иначе (`Workspace.documentLanguage`).
 */
export const DEFAULT_DOCUMENT_LANGUAGE: Locale = REGION_PROFILE_KZ.defaultLocale;

/**
 * СЛОВА ЯЗЫКА БУМАГИ — не языка интерфейса и не языка зрителя.
 *
 * Значение, которое ПЕЧАТАЕТСЯ внутри документа (юрформа «ЖШС», вид кадрового
 * действия, «серия … № … от …», основание подписи), обязано говорить на языке
 * этого документа: английское «Transfer» посреди русского приказа — не перевод,
 * а порча документа. Язык бланка приезжает в контекст резолва
 * (`TemplateFieldContext.language`), а собирается строка ЗДЕСЬ, на сервере:
 * клиент говорит на языке своего человека и о языке бумаги ничего не знает.
 *
 * Язык не задан — язык ИСТОЧНИКА: молчаливого умолчания у бумаги нет, и такой
 * вызов виден и в коде, и в самом документе.
 */
export function documentWords(i18n: I18nService, language: Locale | undefined) {
  const locale = language ?? SOURCE_LOCALE;
  return {
    locale,
    /** Слово каталога в языке бумаги. Ключ ПОЛНЫЙ: `templates.print.vatSeries`. */
    t: (key: string, values?: Record<string, string | number>) => i18n.translateFor(locale, key, values),
    /** Он же с относительным ключом неймспейса «Контрагенты» (основание подписи) */
    cp: (key: string, values?: Record<string, string>) => i18n.translateFor(locale, `counterparties.${key}`, values),
    /** Дата правилами региона и словами языка бумаги */
    date: (value: string | Date) => i18n.format(locale).date(value),
  };
}

export type DocumentWords = ReturnType<typeof documentWords>;
