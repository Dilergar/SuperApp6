import { z } from 'zod';
import { DI_TOKENS } from '../../shared/di-tokens';
import type { ProcessNodeProvider } from './process-node.types';
import { subjectDocumentId } from './process-document-nodes';

// ============================================================
// Ноды КЭДО (modules/hr) — маршруты кадровых документов.
//
// Правило платформы: всё, что делает система, стоит нодой на канвасе. Кадровое
// действие применяется не «где-то внутри после подписи», а нодой «Применить» —
// и по схеме кадровик объясняет проверяющему, когда меняются данные.
// Сервис резолвится ленивым токеном (паттерн doc.*-нод).
// ============================================================

const SURFACES = ['documents.hr'];

/**
 * Порт нод hr.* к сервису КЭДО (резолвится токеном DI_TOKENS.HrService).
 * Экспортирован, чтобы HrService объявил `implements HrNodesPort` —
 * компиляторная гарантия, что делегаты нод не пропадут молча.
 */
export interface HrNodesPort {
  onRouteReachedApply(hrActionId: string): Promise<{ scheduled: boolean }>;
  ensureEsutdSubmission(opts: {
    workspaceId: string;
    userId: string;
    kind: 'contract' | 'amendment' | 'termination';
    baseDate: string;
    hrActionId?: string | null;
  }): Promise<void>;
}

function requireHrAction(variables: Record<string, unknown>): string {
  const id = variables._hrActionId;
  if (typeof id !== 'string' || !id) {
    throw new Error(
      'Эта нода работает в маршруте ПРИКАЗА кадрового действия: документ должен быть создан кнопкой действия («Уволить», «Перевести»…), а не подан вручную',
    );
  }
  return id;
}

export const HR_PROCESS_NODES: ProcessNodeProvider[] = [
  // ---------------------------------------------------------------
  // Применить кадровое действие
  // ---------------------------------------------------------------
  {
    descriptor: {
      type: 'hr.apply',
      title: 'Применить кадровое действие',
      description:
        'Применяет кадровое действие приказа: в дату вступления в силу (но не раньше подписи). Дата в будущем — действие ждёт её отложенно; проверка законности (ст. 54 ТК РК) повторяется в момент применения.',
      category: 'service',
      icon: 'userGear',
      tier: 'standard',
      surfaces: SURFACES,
      outputs: [{ key: 'main', label: 'Дальше' }],
      fields: [],
      configSchema: z.object({}),
      auto: true,
    },
    async run(ctx) {
      const hrActionId = requireHrAction(ctx.variables);
      const hr = ctx.deps.getService<HrNodesPort>(DI_TOKENS.HrService);
      const { scheduled } = await hr.onRouteReachedApply(hrActionId);
      return { kind: 'complete', output: { hrActionId, scheduled } };
    },
  },

  // ---------------------------------------------------------------
  // Поставить сдачу в ЕСУТД
  // ---------------------------------------------------------------
  {
    descriptor: {
      type: 'hr.esutd',
      title: 'Сдать в ЕСУТД',
      description:
        'Ставит сдачу сведений в ЕСУТД (erdo.enbek.kz) в очередь со сроком по производственному календарю: заключение — 5 рабочих дней, изменения — 15 календарных, прекращение — 3 рабочих (Правила № 353). Обычно её ставит само применение действия; нода — для маршрутов, где сдача нужна отдельно.',
      category: 'service',
      icon: 'bank',
      tier: 'standard',
      surfaces: SURFACES,
      outputs: [{ key: 'main', label: 'Дальше' }],
      fields: [
        {
          key: 'kind',
          label: 'Вид сведений',
          kind: 'select',
          required: true,
          options: [
            { value: 'contract', label: 'Заключение договора' },
            { value: 'amendment', label: 'Изменение договора' },
            { value: 'termination', label: 'Прекращение договора' },
          ],
        },
      ],
      configSchema: z.object({ kind: z.enum(['contract', 'amendment', 'termination']) }),
      auto: true,
    },
    async run(ctx) {
      const documentId = subjectDocumentId(ctx.variables);
      const hrActionId = typeof ctx.variables._hrActionId === 'string' ? ctx.variables._hrActionId : null;
      const subjectUserId = typeof ctx.variables._subjectUserId === 'string' ? ctx.variables._subjectUserId : null;
      if (!subjectUserId) {
        throw new Error('Нода «Сдать в ЕСУТД» требует документа со стороной-сотрудником');
      }
      const cfg = ctx.config as { kind: 'contract' | 'amendment' | 'termination' };
      const hr = ctx.deps.getService<HrNodesPort>(DI_TOKENS.HrService);
      await hr.ensureEsutdSubmission({
        workspaceId: ctx.workspaceId,
        userId: subjectUserId,
        kind: cfg.kind,
        baseDate: new Date().toISOString().slice(0, 10),
        hrActionId,
      });
      return { kind: 'complete', output: { documentId, kind: cfg.kind } };
    },
  },
];
