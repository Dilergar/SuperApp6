import { z } from 'zod';
import { DI_TOKENS } from '../../shared/di-tokens';
import type { ProcessNodeProvider } from './process-node.types';

// ============================================================
// Ноды маршрута ДОКУМЕНТА (сервис «Документы», Этап 4).
//
// Правило сервиса: всё, что делает система, стоит нодой на канвасе. Номер не
// присваивается «где-то внутри», подшивка не случается «сама» — их видно на схеме,
// и по ней же кадровик объясняет проверяющему, как устроен процесс.
//
// Ноды НЕ импортируют сервис Документов напрямую (это замкнуло бы модули):
// он резолвится ленивым токеном, как ShopService у Задачника.
// ============================================================

const SURFACES = ['documents.hr', 'documents.general'];

/** Ленивый доступ к сервису «Документы» из ноды */
interface DocumentsPort {
  systemRegister(documentId: string): Promise<string>;
  systemMarkSigned(documentId: string): Promise<void>;
  systemGenerateChild(
    parentDocumentId: string,
    opts: { templateId: string; title?: string; actorId: string },
  ): Promise<string>;
  systemFile(documentId: string): Promise<void>;
  documentOrThrow(documentId: string): Promise<{ id: string; title: string; number: string | null }>;
}

/**
 * Предмет маршрута. Документ кладёт свои служебные ключи в анкету при старте, и
 * ноды берут их отсюда. Санитайзер внешних стартов такие ключи отбрасывает —
 * подделать «маршрут ведёт документ» чужим вебхуком нельзя.
 */
export function subjectDocumentId(variables: Record<string, unknown>): string | null {
  const type = variables._subjectRefType;
  const id = variables._subjectRefId;
  return type === 'org_document' && typeof id === 'string' && id ? id : null;
}

function requireDocument(variables: Record<string, unknown>): string {
  const id = subjectDocumentId(variables);
  if (!id) {
    throw new Error('this node only works inside a document route (started by the document-submitted trigger)');
  }
  return id;
}

export const DOCUMENT_PROCESS_NODES: ProcessNodeProvider[] = [
  // ---------------------------------------------------------------
  // Триггер: документ отправлен на маршрут
  // ---------------------------------------------------------------
  {
    descriptor: {
      type: 'trigger.document',
      category: 'trigger',
      icon: 'file',
      tier: 'standard',
      surfaces: SURFACES,
      // Точка входа процесса: без этого флага компилятор не считает ноду триггером —
      // маршрут получает «нет ни одного триггера запуска», а все шаги за ним
      // объявляются недостижимыми (категория для палитры, флаг — для движка).
      trigger: true,
      inputs: [],
      outputs: [{ key: 'main' }],
      fields: [
        {
          key: 'templateId',

          kind: 'text',
          required: true
        }
      ],
      configSchema: z.object({ templateId: z.string().uuid() }),
      // Триггер сам ничего не делает: движок стартует токен с него.
      auto: true,
    },
    async run() {
      return { kind: 'complete' };
    },
  },

  // ---------------------------------------------------------------
  // Сформировать документ по шаблону (приказ из заявления)
  // ---------------------------------------------------------------
  {
    descriptor: {
      type: 'doc.generate',
      category: 'service',
      icon: 'filePlus',
      tier: 'standard',
      surfaces: SURFACES,
      outputs: [{ key: 'main' }],
      fields: [
        { key: 'templateId', kind: 'text', required: true },
        { key: 'title', kind: 'text' }
      ],
      configSchema: z.object({
        templateId: z.string().uuid(),
        title: z.string().trim().max(200).optional(),
      }),
      auto: true,
    },
    async run(ctx) {
      const parentId = requireDocument(ctx.variables);
      const cfg = ctx.config as { templateId: string; title?: string };
      const documents = ctx.deps.getService<DocumentsPort>(DI_TOKENS.DocumentsService);
      const childId = await documents.systemGenerateChild(parentId, {
        templateId: cfg.templateId,
        title: cfg.title ? ctx.render(cfg.title) : undefined,
        actorId: ctx.startedById,
      });
      // Дальше по маршруту предметом становится СФОРМИРОВАННЫЙ документ: подписывают
      // и регистрируют приказ, а не заявление, которое было основанием.
      return {
        kind: 'complete',
        output: { documentId: childId },
        setVariables: { _subjectRefType: 'org_document', _subjectRefId: childId },
      };
    },
  },

  // ---------------------------------------------------------------
  // Регистрация номера
  // ---------------------------------------------------------------
  {
    descriptor: {
      type: 'doc.register',
      category: 'service',
      icon: 'list',
      tier: 'standard',
      surfaces: SURFACES,
      outputs: [{ key: 'main' }],
      fields: [],
      configSchema: z.object({}),
      auto: true,
    },
    async run(ctx) {
      const documentId = requireDocument(ctx.variables);
      const documents = ctx.deps.getService<DocumentsPort>(DI_TOKENS.DocumentsService);
      const number = await documents.systemRegister(documentId);
      return { kind: 'complete', output: { number }, setVariables: { _documentNumber: number } };
    },
  },

  // ---------------------------------------------------------------
  // Подшить в дело
  // ---------------------------------------------------------------
  {
    descriptor: {
      type: 'doc.file',
      category: 'service',
      icon: 'archive',
      tier: 'standard',
      surfaces: SURFACES,
      outputs: [{ key: 'main' }],
      fields: [],
      configSchema: z.object({}),
      auto: true,
    },
    async run(ctx) {
      const documentId = requireDocument(ctx.variables);
      const documents = ctx.deps.getService<DocumentsPort>(DI_TOKENS.DocumentsService);
      await documents.systemMarkSigned(documentId);
      await documents.systemFile(documentId);
      return { kind: 'complete' };
    },
  },
];
