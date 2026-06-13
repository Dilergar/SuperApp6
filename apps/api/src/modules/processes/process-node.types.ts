import type { z } from 'zod';
import type {
  ProcessDocument,
  ProcessFormField,
  ProcessNodeTypeDto,
  ProcessValidationIssue,
} from '@superapp/shared';
import type { TasksService } from '../tasks/tasks.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { DatabaseService } from '../../shared/database/database.service';

/**
 * Паспорт типа ноды — «MCP-описание инструмента» (Принцип 4 / решение по AI-readiness):
 * одна регистрация кормит палитру канваса, серверную валидацию и будущие AI/MCP-поверхности.
 * Сериализуемая часть (ProcessNodeTypeDto) уходит клиенту как есть.
 */
export interface ProcessNodeDescriptor extends ProcessNodeTypeDto {
  /** Zod-схема config (значения хранятся ИМЕНОВАННО — урок ComfyUI про positional widgets_values). */
  configSchema: z.ZodTypeAny;
  /**
   * auto-ноды движок проходит цепочкой сам (условие/уведомление/конец);
   * не-auto ждут внешнего события (человеческая задача) — токен «спит» строкой БД.
   */
  auto: boolean;
  /** Ф2.5: выход «main» может вести к нескольким нодам (fork/развилка) — спавнит токен на каждую. */
  multiOut?: boolean;
  /** Ф2.5: join-нода — несколько входящих рёбер сливаются в один токен (ждёт всех). */
  join?: boolean;
  /** Ф4.5: под-нода-инструмент отдаёт агенту этот tool (имя/схема/исполнение). */
  tool?: ToolSpec;
}

/** Контекст выполнения одного шага (готовый валидированный config + подстановки). */
export interface NodeRunContext {
  instanceId: string;
  workspaceId: string;
  /** Инициатор процесса — от его имени создаются задачи/уведомления. */
  startedById: string;
  /** Имя процесса (для текстов уведомлений). */
  definitionName: string;
  /** Анкета процесса (значения стартовой формы). */
  variables: Record<string, unknown>;
  step: { id: string; nodeId: string; label: string };
  /** Для join-ноды: текущие/ожидаемые прибытия токенов (иначе undefined). */
  join?: JoinContext;
  /** Для агента (Ф4.5): подключённые Модель/Память/Инструменты (собрано движком). */
  cluster?: AgentCluster;
  config: Record<string, unknown>;
  /** Подстановки `{{form.поле}}` / `{{initiator.name}}` / `{{instance.name}}`. */
  render: (text: string) => string;
  deps: NodeRunDeps;
}

/** Сервисы платформы, доступные нодам (движок собирает, ноды остаются чистыми объектами). */
export interface NodeRunDeps {
  tasks: TasksService;
  notifications: NotificationsService;
  db: DatabaseService;
}

export interface WaitPatch {
  taskId?: string;
  assigneeId?: string;
  /** Задача на отдел (очередь): кто может забрать. */
  departmentId?: string;
  /** SLA-дедлайн человеческого шага ИЛИ время побудки паузы. */
  deadlineAt?: Date;
}

/** Контекст join-ноды (Ф2.5): сколько токенов уже пришло и сколько ждём. */
export interface JoinContext {
  arrivals: number;
  expected: number;
}

// ---------- Ф4.5: cluster-модель (агент + под-ноды через типизированные порты) ----------

/** Инструмент, доступный агенту (LLM tool-calling): из под-ноды-инструмента или под-агента. */
export interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
}

/** Резолвнутая модель (ключ уже достан из сейфа). Совпадает с LlmConfig клиента. */
export interface AgentModel {
  provider: 'anthropic' | 'openai' | 'openai-compatible';
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Память агента (по ключу сессии в Redis) — закрывашки строит движок. */
export interface AgentMemory {
  load: () => Promise<string>;
  append: (userText: string, assistantText: string) => Promise<void>;
}

/** Кластер агента: подключённые под-ноды (Модель/Память/Инструменты/Парсер), собран движком. */
export interface AgentCluster {
  model: AgentModel;
  memory?: AgentMemory;
  tools: AgentTool[];
  systemPrompt?: string;
  /** Парсер структурированного ответа (под-нода «Структурированный ответ»): инструкция для LLM. */
  outputParser?: { instruction: string };
}

/** Описание инструмента, которое под-нода-инструмент отдаёт агенту (имя/схема для LLM + исполнение). */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  execute: (ctx: NodeRunContext, input: Record<string, unknown>) => Promise<string>;
}

export type NodeRunResult =
  /** Шаг завершён — токен уходит по выходному порту (по умолчанию 'main'). */
  | { kind: 'complete'; outputKey?: string; output?: Record<string, unknown> }
  /** Шаг ждёт внешнего события (задача принята, claim, решение, таймер); patch пишется в строку. */
  | { kind: 'wait'; patch?: WaitPatch; output?: Record<string, unknown> };

/** Поставщик типа ноды: паспорт + выполнение + опциональная кросс-валидация против документа. */
export interface ProcessNodeProvider {
  descriptor: ProcessNodeDescriptor;
  run(ctx: NodeRunContext): Promise<NodeRunResult>;
  /** Проверки, которым нужен документ целиком (ссылки на поля анкеты и т.п.). */
  validateConfig?(
    config: Record<string, unknown>,
    doc: ProcessDocument,
  ): ProcessValidationIssue[];
}

/** Скомпилированный план исполнения (IR) — то, что реально гоняет движок (модель ComfyUI prompt). */
export interface CompiledPlan {
  /** Точка входа ручного запуска (триггер-нода «Запуск вручную», тип 'start'); back-compat. */
  startNodeId: string;
  /** Все триггер-ноды (точки входа). Каждый триггер запускает токен со своего узла. */
  entryNodeIds: string[];
  form: ProcessFormField[];
  nodes: Record<
    string,
    {
      type: string;
      label: string;
      config: Record<string, unknown>;
      terminal: boolean;
      auto: boolean;
      /** Ф2.5: join-нода — сливает параллельные ветки (ждёт joinExpected токенов). */
      join: boolean;
      /** Ф4.5: нода потребляет под-ноды через ai_*-порты (агент) — движок собирает cluster. */
      cluster: boolean;
    }
  >;
  /** nodeId → outputKey → СПИСОК следующих нод (fork-порт ведёт к нескольким; обычный — к одной). */
  adjacency: Record<string, Record<string, string[]>>;
  /** Ф2.5: join-нода → сколько токенов ждать (= число входящих рёбер). */
  joinExpected: Record<string, number>;
  /** Ф4.5: nodeId агента → тип порта (ai_model/ai_memory/ai_tool) → id подключённых под-нод. */
  attachments: Record<string, Record<string, string[]>>;
}
