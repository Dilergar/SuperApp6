import { Injectable, Logger } from '@nestjs/common';
import type { TemplateFieldGroupDto, TemplateFieldSpecDto } from '@superapp/shared';

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

export interface TemplateFieldGroup {
  /** Ключ в коде (латиницей): workspace | employee | document … */
  key: string;
  /** Префикс тега до точки — то, что пишет сотрудник: «Организация» */
  tagPrefix: string;
  label: string;
  fields: TemplateFieldSpecDto[];
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
        this.logger.error(`Дополнитель контекста упал: ${(e as Error).message}`);
      }
    }
    return out;
  }

  register(group: TemplateFieldGroup): void {
    if (this.byKey.has(group.key) || this.byPrefix.has(group.tagPrefix)) {
      // Дубль регистрации — ошибка сборки приложения, а не рантайма
      throw new Error(`TemplateFieldRegistry: группа «${group.key}»/«${group.tagPrefix}» уже зарегистрирована`);
    }
    this.byKey.set(group.key, group);
    this.byPrefix.set(group.tagPrefix, group);
    this.logger.log(`Группа полей шаблона: «${group.tagPrefix}» (${group.fields.length} полей)`);
  }

  list(): TemplateFieldGroupDto[] {
    return [...this.byKey.values()].map((g) => ({
      key: g.key,
      tagPrefix: g.tagPrefix,
      label: g.label,
      fields: g.fields,
    }));
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
        this.logger.error(`Резолвер группы «${group.tagPrefix}» упал: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
