import { Injectable } from '@nestjs/common';
import { localizePersonSnapshot, resolveAudienceLabels, resolveByteValues, resolveCountryValues, resolveIsoValues, resolveLabelKeys, type Locale } from '@superapp/i18n';
import { PERSON_NAME_REFS, notificationDef } from '@superapp/shared';
import { I18nService } from '../../shared/i18n/i18n.service';

export interface RenderedText {
  title: string;
  body: string | null;
}

/**
 * Текст уведомления собирается ПРИ ЧТЕНИИ (render-at-read, docs/i18n.md): в БД лежит
 * `type + payload`, слова — в каталоге `notifications.<type>.title|body`. Схлопнутая
 * строка берёт `notifications.<type>.collapsed` («Изменено 12 ваших смен»), если
 * каталог его знает, иначе — обычный заголовок (счётчик рисует клиент).
 * Тип, ушедший из реестра, показывает снимок, запечённый при отправке.
 */
@Injectable()
export class NotificationsRenderer {
  constructor(private readonly i18n: I18nService) {}

  render(
    locale: Locale,
    type: string,
    payload: Record<string, unknown>,
    opts: { collapseCount?: number; snapshot?: { title?: unknown; body?: unknown } | null } = {},
  ): RenderedText {
    const def = notificationDef(type);
    const snapshot = opts.snapshot ?? null;
    if (!def && snapshot) {
      return {
        title: typeof snapshot.title === 'string' ? snapshot.title : type,
        body: typeof snapshot.body === 'string' ? snapshot.body : null,
      };
    }
    const n = opts.collapseCount ?? 1;
    // `<имя>Key` в payload — КЛЮЧ каталога, а не слово: вид кадрового действия,
    // способ вручения и прочие слова продукта не вправе застыть в языке того,
    // кто нажал кнопку (docs/i18n.md, render-at-read). `<имя>Iso` — та же идея для
    // машинной даты: «2026-09» превращается в «сентябрь 2026» правилами зрителя,
    // `<имя>Audience` — для адресата (ключ формы + имя справочника снимком).
    // Адресат («Отдел «Продажи»») лежит в payload СНИМКОМ структуры и собирается
    // словом здесь — до `toValues`, которая выбрасывает объекты.
    const t = this.i18n.forLocale(locale);
    const withAudiences = resolveAudienceLabels(t, payload ?? {});
    // `<имя>Bytes` — машинный объём (квоты Диска): «4,1 ГБ» собирается единицами и
    // правилами зрителя, а не запечённой строкой продюсера.
    // `<имя>Country` — код страны (гео-заголовок CDN): имя страны — на языке зрителя.
    const fmt = this.i18n.format(locale);
    const values = resolveLabelKeys(
      t,
      resolveCountryValues(fmt, resolveIsoValues(fmt, resolveByteValues((v) => this.i18n.bytes(v, locale), { ...toValues(withAudiences), n }))),
    );
    // Имя стёртого человека в payload — маркер томбстоуна: зритель видит метку на своём языке
    for (const key of Object.keys(PERSON_NAME_REFS)) {
      if (typeof values[key] === 'string') values[key] = localizePersonSnapshot(t, values[key] as string);
    }
    const titleKey = `notifications.${type}.title`;
    const bodyKey = `notifications.${type}.body`;
    const collapsedKey = `notifications.${type}.collapsed`;
    if (!this.i18n.has(titleKey, locale)) {
      return {
        title: typeof snapshot?.title === 'string' ? snapshot.title : type,
        body: typeof snapshot?.body === 'string' ? snapshot.body : null,
      };
    }
    const title =
      n > 1 && this.i18n.has(collapsedKey, locale)
        ? this.i18n.translateFor(locale, collapsedKey, values)
        : this.i18n.translateFor(locale, titleKey, values);
    const body = this.i18n.has(bodyKey, locale) ? this.i18n.translateFor(locale, bodyKey, values) : null;
    return { title, body: body && body.trim().length > 0 ? body : null };
  }
}

/**
 * payload → значения ICU. Объекты и массивы отбрасываются: в тексте для человека им
 * взяться неоткуда, а «[object Object]» на экране — способ узнать об этом от пользователя.
 */
export function toValues(payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    out[key] = value as string | number | boolean;
  }
  return out;
}
