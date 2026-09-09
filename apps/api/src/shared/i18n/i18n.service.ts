import { Injectable, Logger } from '@nestjs/common';
import {
  createFormatters,
  formatBytes,
  REGION_PROFILE_KZ,
  createT,
  negotiateLocale,
  coerceLocale,
  DEFAULT_LOCALE,
  type Formatters,
  type IntlError,
  type Locale,
  type TranslationValues,
  type Translator,
} from '@superapp/i18n';
import { WorkspaceContextService } from '../context/workspace-context.service';
import { DatabaseService } from '../database/database.service';

// ============================================================
// I18nService — единственная дверь к словам на сервере.
//
// Три источника языка, и путать их нельзя:
//  • ЗАПРОС — `Accept-Language` клиента, лежит в ALS (WorkspaceContext.locale).
//    Так рендерятся ответы ручек: список уведомлений, текст хроники, отказы.
//  • ФОН — `User.locale` адресата из БД (`localesFor`). Так рендерятся push,
//    SMS и письма: у джоба нет запроса, а у человека есть выбранный язык.
//  • ИСТОЧНИК — `SOURCE_LOCALE` (en). Так пишется то, что ложится В БД как
//    поисковый/превью-фолбэк (`content` системной плашки).
//
// Переводчики кэшируются: каталоги неизменяемы, а `createT` строит дерево
// слияния с фолбэком — делать это на каждый запрос незачем.
// ============================================================

@Injectable()
export class I18nService {
  private readonly logger = new Logger(I18nService.name);
  private readonly translators = new Map<Locale, Translator>();
  private readonly formatters = new Map<string, Formatters>();

  constructor(
    private readonly ctx: WorkspaceContextService,
    private readonly db: DatabaseService,
  ) {}

  /** Язык ТЕКУЩЕГО запроса (из ALS). Вне запроса — язык по умолчанию. */
  get locale(): Locale {
    return this.ctx.get()?.locale ?? DEFAULT_LOCALE;
  }

  /** Переводчик языка запроса. */
  get t(): Translator {
    return this.forLocale(this.locale);
  }

  /** Переводчик конкретного языка (фон, рассылки). */
  forLocale(locale: Locale): Translator {
    let hit = this.translators.get(locale);
    if (!hit) {
      hit = createT(locale, undefined, {
        onError: (err: IntlError) => this.logger.warn(`[i18n:${locale}] ${err.code}: ${err.message}`),
      });
      this.translators.set(locale, hit);
    }
    return hit;
  }

  /** Перевод в языке запроса. Ключ — полный: `errors.db.notFound`. */
  translate(key: string, values?: TranslationValues): string {
    return this.t(key, values);
  }

  /**
   * Размер файла словами языка и правилами региона («1,4 МБ» / «1.4 MB»).
   * Единицы живут в каталоге, поэтому свой `${(b/1024).toFixed(1)} КБ` в сервисе
   * был бы сразу и языком, и регионом.
   */
  bytes(value: number, locale: Locale = this.locale): string {
    const t = this.forLocale(locale);
    return formatBytes(
      value,
      { locale },
      { b: t('common.units.b'), kb: t('common.units.kb'), mb: t('common.units.mb'), gb: t('common.units.gb') },
    );
  }

  /** Перевод в заданном языке (фон: push/SMS в `User.locale` адресата). */
  translateFor(locale: Locale, key: string, values?: TranslationValues): string {
    return this.forLocale(locale)(key, values);
  }

  /** Есть ли такой ключ (у уведомлений тело необязательно). */
  has(key: string, locale: Locale = this.locale): boolean {
    return this.forLocale(locale).has(key);
  }

  /**
   * Выполнить работу в заданном языке — для джобов, которые рендерят текст
   * пачкой на разных адресатов. Внутри `fn` `this.locale` вернёт `locale`.
   */
  withLocale<T>(locale: Locale, fn: () => T): T {
    const prev = this.ctx.get();
    return this.ctx.run({ ...(prev ?? {}), locale }, fn);
  }

  /**
   * Форматтеры языка — даты, числа, деньги по профилю региона.
   *
   * Пояс по умолчанию — пояс ПРОДУКТА (Asia/Almaty), а не окружения сервера:
   * сервер стоит в UTC, и «14:35» в тексте, который он рисует, обязано остаться
   * алматинским. Пояс устройства знает только браузер — он и перерисовывает
   * ленты у себя; фон (push/SMS) передаёт сюда `User.timezone` адресата.
   */
  format(locale: Locale = this.locale, timeZone?: string): Formatters {
    const zone = timeZone ?? REGION_PROFILE_KZ.defaultTimeZone;
    const key = `${locale}|${zone}`;
    let hit = this.formatters.get(key);
    if (!hit) {
      hit = createFormatters(locale, zone);
      this.formatters.set(key, hit);
    }
    return hit;
  }

  /**
   * Языки адресатов одним запросом — фоновая рассылка не должна делать N+1
   * походов в `users` ради одного поля. Отсутствующий/битый `locale` в БД
   * (строка из прошлой эпохи) нормализуется в язык по умолчанию.
   */
  async localesFor(userIds: readonly string[]): Promise<Map<string, Locale>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    const out = new Map<string, Locale>();
    if (ids.length === 0) return out;
    const rows = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, locale: true },
    });
    for (const row of rows) out.set(row.id, coerceLocale(row.locale));
    // Пользователь мог быть удалён между эмиссией события и рассылкой — язык
    // по умолчанию лучше, чем падение джоба.
    for (const id of ids) if (!out.has(id)) out.set(id, DEFAULT_LOCALE);
    return out;
  }

  /** Язык одного адресата (частый случай — точечное уведомление). */
  async localeOf(userId: string): Promise<Locale> {
    return (await this.localesFor([userId])).get(userId) ?? DEFAULT_LOCALE;
  }

  /** Разбор заголовка `Accept-Language` (тот же движок, что у веба). */
  negotiate(acceptLanguage?: string | null, preferred?: string | null): Locale {
    return negotiateLocale(acceptLanguage, preferred);
  }
}
