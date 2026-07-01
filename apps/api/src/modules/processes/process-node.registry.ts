import { Injectable, Logger } from '@nestjs/common';
import { PROCESS_ONERROR_OPTIONS, type ProcessNodeTypeDto, type ProcessNodeField } from '@superapp/shared';
import type { ProcessNodeProvider } from './process-node.types';

/**
 * Реестр типов нод — 5-й платформенный реестр (после access/rich-cards/search/quick-actions).
 * Встроенные ноды регистрирует ProcessesService на init; будущие сервисы (CRM, Магазин…)
 * добавляют свои ноды одной регистрацией — канвас и валидация «загораются» сами.
 */
@Injectable()
export class ProcessNodeRegistry {
  private readonly logger = new Logger(ProcessNodeRegistry.name);
  private readonly providers = new Map<string, ProcessNodeProvider>();

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

  /** Сериализованные паспорта для палитры (system-ноды — только платформенной роли). */
  listTypes(includeSystem: boolean): ProcessNodeTypeDto[] {
    return this.all()
      .filter((p) => includeSystem || p.descriptor.tier !== 'system')
      .map((p) => {
        const d = p.descriptor;
        // multiOut/join остаются в DTO (нужны редактору для множественных/входящих связей);
        // configSchema/auto/io — серверные (валидация/исполнение), клиенту не нужны.
        const { configSchema: _s, auto: _a, io: _io, ...dto } = d;
        // Ф2: универсальные поля обработки ошибок авто-рендерятся в NDV (пишутся в config,
        // компилятор извлекает их отдельно). Триггеры/под-ноды/терминал их не имеют;
        // повторы при сбое — только для нод внешнего I/O.
        if (d.trigger || d.subNode || d.terminal) return dto;
        const extra: ProcessNodeField[] = [
          {
            key: 'onError',
            label: 'При ошибке',
            kind: 'select',
            options: PROCESS_ONERROR_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
            help: 'Что делать, если шаг упал: остановить процесс (по умолчанию), продолжить или уйти в ветку «Ошибка».',
          },
        ];
        if (d.io) {
          extra.push({ key: 'retryMaxTries', label: 'Повторов при сбое (0–5)', kind: 'number', placeholder: '0', help: 'Сколько раз повторить при сбое внешнего вызова, прежде чем применить «При ошибке».' });
          extra.push({ key: 'retryWaitMs', label: 'Пауза между повторами, мс', kind: 'number', placeholder: '1000' });
        }
        return { ...dto, fields: [...dto.fields, ...extra] };
      });
  }
}
