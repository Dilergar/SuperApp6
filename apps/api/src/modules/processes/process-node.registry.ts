import { Injectable, Logger } from '@nestjs/common';
import { SOURCE_LOCALE, type Translator } from '@superapp/i18n';
import {
  PROCESS_ONERROR_OPTIONS,
  type ProcessNodeField,
  type ProcessNodeOutput,
  type ProcessNodeTypeDto,
} from '@superapp/shared';
import { I18nService } from '../../shared/i18n/i18n.service';
import type { DescriptorField, ProcessNodeProvider } from './process-node.types';

/**
 * Реестр типов нод — 5-й платформенный реестр (после access/rich-cards/search/quick-actions).
 * Встроенные ноды регистрирует ProcessesService на init; будущие сервисы (CRM, Магазин…)
 * добавляют свои ноды одной регистрацией — канвас и валидация «загораются» сами.
 */
@Injectable()
export class ProcessNodeRegistry {
  private readonly logger = new Logger(ProcessNodeRegistry.name);
  private readonly providers = new Map<string, ProcessNodeProvider>();

  constructor(private readonly i18n: I18nService) {}

  /**
   * Слово каталога по ГОТОВОМУ ключу. Ключа нет — отдаём его сам: сообщения
   * старых сохранённых документов и чужих схем не должны превращаться в пустоту.
   */
  text(key: string, params?: Record<string, string | number>): string {
    return this.i18n.has(key) ? this.i18n.translate(key, params) : key;
  }

  /**
   * Название типа ноды — оно же запасная подпись шага, когда автор ноду не назвал.
   * Тип неизвестен (паспорт снесли, а нарисованные процессы остались) — отдаём сам
   * тип: пустая подпись хуже машинного ключа.
   */
  title(type: string): string {
    const key = `processes.node.${type}.title`;
    return this.i18n.has(key) ? this.i18n.translate(key) : type;
  }

  /**
   * То же название, но в языке ИСТОЧНИКА — для снимков, которые ложатся в БД
   * (подпись шага в скомпилированном плане переживает и смену языка автора, и
   * саму публикацию).
   */
  sourceTitle(type: string): string {
    const key = `processes.node.${type}.title`;
    return this.i18n.has(key, SOURCE_LOCALE) ? this.i18n.translateFor(SOURCE_LOCALE, key) : type;
  }

  register(provider: ProcessNodeProvider): void {
    const type = provider.descriptor.type;
    if (this.providers.has(type)) {
      this.logger.warn(`process node "${type}" already registered — overwriting`);
    }
    this.providers.set(type, provider);
  }

  get(type: string): ProcessNodeProvider | undefined {
    return this.providers.get(type);
  }

  all(): ProcessNodeProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Сериализованные паспорта для палитры (system-ноды — только платформенной роли).
   * Слова собираются ЗДЕСЬ и в языке запроса — паспорт их не хранит.
   */
  listTypes(includeSystem: boolean): ProcessNodeTypeDto[] {
    const t = this.i18n.t;
    return this.all()
      .filter((p) => includeSystem || p.descriptor.tier !== 'system')
      .map((p) => {
        const d = p.descriptor;
        // multiOut/join остаются в DTO (нужны редактору для множественных/входящих связей);
        // configSchema/auto/io — серверные (валидация/исполнение), клиенту не нужны.
        const { configSchema: _s, auto: _a, io: _io, outputs, inputs, fields, ...rest } = d;
        const base = `processes.node.${d.type}`;
        const dto: ProcessNodeTypeDto = {
          ...rest,
          title: t(`${base}.title`),
          description: t(`${base}.description`),
          outputs: outputs.map(
            (o): ProcessNodeOutput => ({
              ...o,
              label: optional(t, `${base}.output.${o.key}`, `processes.output.${o.key}`) ?? '',
            }),
          ),
          ...(inputs
            ? {
                inputs: inputs.map((i) => ({
                  ...i,
                  label: optional(t, `${base}.input.${i.key}`, `processes.input.${i.key}`),
                })),
              }
            : {}),
          fields: fields.map((f) => renderField(t, base, f)),
        };
        // Ф2: универсальные поля обработки ошибок авто-рендерятся в NDV (пишутся в config,
        // компилятор извлекает их отдельно). Триггеры/под-ноды/терминал их не имеют;
        // повторы при сбое — только для нод внешнего I/O.
        if (d.trigger || d.subNode || d.terminal) return dto;
        const extra: ProcessNodeField[] = [
          {
            key: 'onError',
            label: t('processes.common.onError.label'),
            kind: 'select',
            options: PROCESS_ONERROR_OPTIONS.map((value) => ({
              value,
              label: t(`processes.common.onError.option.${value}`),
            })),
            help: t('processes.common.onError.help'),
          },
        ];
        if (d.io) {
          extra.push({
            key: 'retryMaxTries',
            label: t('processes.common.retryMaxTries.label'),
            kind: 'number',
            placeholder: '0',
            help: t('processes.common.retryMaxTries.help'),
          });
          extra.push({
            key: 'retryWaitMs',
            label: t('processes.common.retryWaitMs.label'),
            kind: 'number',
            placeholder: '1000',
          });
        }
        return { ...dto, fields: [...dto.fields, ...extra] };
      });
  }
}

/**
 * Первый ключ, который есть в каталоге. Порядок несущий: своё слово ноды
 * ПЕРЕВЕШИВАЕТ общее (`processes.field.*`, `processes.output.*`), а «нет ни
 * одного» — законный ответ для подписи выхода, подсказки и placeholder.
 */
function optional(t: Translator, ...keys: string[]): string | undefined {
  const hit = keys.find((k) => t.has(k));
  return hit ? t(hit) : undefined;
}

/**
 * Слова поля. Один и тот же ключ поля встречается у разных нод (`credentialId`,
 * `text`, `model`…) — общая ветка `processes.field.<ключ>` не даёт переписывать
 * одно и то же по числу нод, а своя ветка ноды её перекрывает.
 *
 * У ЗНАЧЕНИЙ списка ступеней три: своё у ноды → общее у ключа поля → общий
 * СЛОВАРЬ значений `processes.option.<значение>`. Последняя нужна словам, которые
 * не зависят ни от ноды, ни от поля: «часов» одинаково у расписания и у паузы,
 * операторы сравнения — у «Если» и у триггера события.
 */
function renderField(t: Translator, base: string, f: DescriptorField): ProcessNodeField {
  const { options, ...rest } = f;
  const own = `${base}.field.${f.key}`;
  const shared = `processes.field.${f.key}`;
  return {
    ...rest,
    label: optional(t, `${own}.label`, `${shared}.label`) ?? f.key,
    help: optional(t, `${own}.help`, `${shared}.help`),
    placeholder: optional(t, `${own}.placeholder`, `${shared}.placeholder`),
    ...(options
      ? {
          options: options.map((value) => ({
            value,
            label:
              optional(t, `${own}.option.${value}`, `${shared}.option.${value}`, `processes.option.${value}`) ??
              value,
          })),
        }
      : {}),
  };
}
