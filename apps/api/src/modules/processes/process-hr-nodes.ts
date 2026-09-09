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
      'this node belongs to the route of an HR ACTION order: the document must be created by an action button, not filed by hand',
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
      category: 'service',
      icon: 'userGear',
      tier: 'standard',
      surfaces: SURFACES,
      outputs: [{ key: 'main' }],
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
      category: 'service',
      icon: 'bank',
      tier: 'standard',
      surfaces: SURFACES,
      outputs: [{ key: 'main' }],
      fields: [
        { key: 'kind', kind: 'select', required: true, options: ['contract', 'amendment', 'termination'] }
      ],
      configSchema: z.object({ kind: z.enum(['contract', 'amendment', 'termination']) }),
      auto: true,
    },
    async run(ctx) {
      const documentId = subjectDocumentId(ctx.variables);
      const hrActionId = typeof ctx.variables._hrActionId === 'string' ? ctx.variables._hrActionId : null;
      const subjectUserId = typeof ctx.variables._subjectUserId === 'string' ? ctx.variables._subjectUserId : null;
      if (!subjectUserId) {
        throw new Error('the ESUTD node needs a document with an employee as a party');
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
