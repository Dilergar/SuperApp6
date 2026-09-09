import { Injectable, Logger } from '@nestjs/common';
import type { Locale } from '@superapp/i18n';
import type { TemplateFieldGroupDto } from '@superapp/shared';
import { I18nService } from '../../shared/i18n/i18n.service';

/**
 * Реестр групп полей шаблона — владельцы данных регистрируют свои группы в
 * onModuleInit (паттерн FilesRefRegistry/ShareLinksRegistry: движок фич не
 * импортирует, направление знания — от потребителя к движку).
 *
 * Сегодня регистрируются: WorkspacesModule → «Организация» (реквизиты + банк),
 * StaffModule → «Сотрудник» (анкета + должность). Сервис «Документы» (Этап 4)
 * добавит «Документ» (номер, дата, поля формы). Завтра Финансы регистрируют
 * «Счёт» одной строкой — код Документов не меняется.
 */

/** Контекст резолва: чего не хватает — та группа просто отвечает null */
export interface TemplateFieldContext {
  /**
   * ЯЗЫК БЛАНКА, в который поедут значения. Значение группы попадает ВНУТРЬ
   * бумаги, поэтому слово в нём («ЖШС», «Перевод», «серия … от …») говорит на
   * языке документа, а не зрителя. Не задан — язык источника: молчаливого
   * умолчания у бумаги нет, и такой вызов виден в коде.
   */
  language?: Locale;
  workspaceId?: string;
  /** Сотрудник-СТОРОНА документа (податель заявления, субъект приказа) */
  subjectUserId?: string;
  /** Кто формирует документ */
  actorUserId?: string;
  /** ВТОРАЯ сторона — контрагент из справочника (внешний контур ЭДО) */
  counterpartyId?: string;
  /** Контактное лицо контрагента — будущий внешний подписант */
  counterpartyContactId?: string;
  /** Шаблон документа — по нему группа «Подписант» находит маршрут и его подписанта */
  templateId?: string;
  /** Кадровое действие (КЭДО) — источник группы «Действие» */
  hrActionId?: string;
  /**
   * ЮРЛИЦО-сторона документа (ТОО подписывает договор, а не бренд-организация).
   * Не задано → головное юрлицо организации.
   */
  legalEntityId?: string;
}

/**
 * Поле группы В РЕЕСТРЕ. Слов не хранит: `key` — это ИМЯ ТЕГА внутри бланка
 * (`{Organization.Bin}`), API-имя поля (модель Salesforce) — одно на все языки
 * бумаги. Подпись и пример в панели «Что подставить» — интерфейс, и живут они
 * в каталоге под ключом, собранным по соглашению:
 *
 *   templates.fields.<группа>.<id>.label
 *   templates.fields.<группа>.<id>.example   (необязателен)
 *
 * `key` и `id` — одно и то же имя в двух написаниях (`Bin` ↔ `bin`), и второе
 * нужно потому, что ключ каталога всегда camelCase. Имя тега пишется ЯВНО:
 * человек ищет `Organization.Bin` по коду и обязан его найти.
 */
export interface TemplateFieldSpec {
  /** То, что стоит в теге после точки: «Bin». Переименование = правка бланков. */
  key: string;
  /** Имя поля для ключа каталога (camelCase от `key`). */
  id: string;
}

export interface TemplateFieldGroup {
  /** Ключ в коде (латиницей): workspace | employee | document … */
  key: string;
  /** Префикс тега до точки — то, что пишет сотрудник: «Organization» */
  tagPrefix: string;
  fields: TemplateFieldSpec[];
  /**
   * Значения группы для подстановки. КОНТРАКТ ЧЕСТНОСТИ: незаполненный
   * реквизит отдаётся null (рендер откажет списком «заполните…»), а не пустой
   * строкой — пустота в приказе хуже отказа. Осознанно-пустое поле — ''.
   */
  resolve(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null>;
}

/**
 * Дополнить контекст перед резолвом групп. Нужен, когда одна фича знает то, чего
 * не знает потребитель: КЭДО по `hrActionId` достаёт ЮРЛИЦО-работодателя, и группа
 * «Организация» печатает реквизиты нужного ТОО, а не головного. Движок при этом
 * по-прежнему не импортирует фичи — направление только обратное (реестр).
 */
export type TemplateContextEnricher = (ctx: TemplateFieldContext) => Promise<TemplateFieldContext>;

@Injectable()
export class TemplateFieldRegistry {
  private readonly logger = new Logger(TemplateFieldRegistry.name);
  private readonly byKey = new Map<string, TemplateFieldGroup>();
  private readonly byPrefix = new Map<string, TemplateFieldGroup>();
  private readonly enrichers: TemplateContextEnricher[] = [];

  constructor(private readonly i18n: I18nService) {}

  /** Дополнитель контекста (регистрирует ВЛАДЕЛЕЦ данных, как слои календаря). */
  registerContextEnricher(fn: TemplateContextEnricher): void {
    this.enrichers.push(fn);
  }

  /** Прогнать контекст через дополнителей; упавший — в лог, документ не рушим. */
  async enrich(ctx: TemplateFieldContext): Promise<TemplateFieldContext> {
    let out = ctx;
    for (const fn of this.enrichers) {
      try {
        out = await fn(out);
      } catch (e) {
        this.logger.error(`a template context enricher failed: ${(e as Error).message}`);
      }
    }
    return out;
  }

  register(group: TemplateFieldGroup): void {
    if (this.byKey.has(group.key) || this.byPrefix.has(group.tagPrefix)) {
      // Дубль регистрации — ошибка сборки приложения, а не рантайма
      throw new Error(`TemplateFieldRegistry: group ${group.key}/${group.tagPrefix} is already registered`);
    }
    this.byKey.set(group.key, group);
    this.byPrefix.set(group.tagPrefix, group);
    this.logger.log(`template field group: ${group.tagPrefix} (${group.fields.length} fields)`);
  }

  /**
   * Панель «Что подставить» — уже СЛОВАМИ, в языке запроса. Реестр слов не
   * хранит, поэтому подпись и пример собираются здесь по ключу-соглашению;
   * пример необязателен, и спрашивать про него каталог надо `has`, иначе
   * рантайм честно ругался бы пропущенным ключом на каждом поле без примера.
   */
  list(): TemplateFieldGroupDto[] {
    return [...this.byKey.values()].map((g) => {
      const base = `templates.fields.${g.key}`;
      return {
        key: g.key,
        tagPrefix: g.tagPrefix,
        label: this.i18n.translate(`${base}.label`),
        fields: g.fields.map((f) => {
          const exampleKey = `${base}.${f.id}.example`;
          return {
            key: f.key,
            label: this.i18n.translate(`${base}.${f.id}.label`),
            ...(this.i18n.has(exampleKey) ? { example: this.i18n.translate(exampleKey) } : {}),
          };
        }),
      };
    });
  }

  prefixes(): Set<string> {
    return new Set(this.byPrefix.keys());
  }

  /** Известен ли путь «Префикс.Поле» реестру (для компилятора) */
  isKnownPath(path: string): boolean {
    const dot = path.indexOf('.');
    if (dot < 0) return false;
    const group = this.byPrefix.get(path.slice(0, dot));
    if (!group) return false;
    const fieldKey = path.slice(dot + 1);
    return group.fields.some((f) => f.key === fieldKey);
  }

  hasPrefix(prefix: string): boolean {
    return this.byPrefix.has(prefix);
  }

  /**
   * Собрать значения всех групп для контекста: { [tagPrefix]: {...} }.
   * Группа, ответившая null, в значения не попадает (её теги честно упадут
   * «не хватает данных»), упавшая — тоже, с ошибкой в лог: сломанный резолвер
   * одной группы не должен прятать документ целиком без следа.
   */
  async resolveValues(rawCtx: TemplateFieldContext): Promise<Record<string, unknown>> {
    const ctx = await this.enrich(rawCtx);
    const out: Record<string, unknown> = {};
    for (const group of this.byKey.values()) {
      try {
        const values = await group.resolve(ctx);
        if (values) out[group.tagPrefix] = values;
      } catch (e) {
        this.logger.error(`the resolver of group ${group.tagPrefix} failed: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
