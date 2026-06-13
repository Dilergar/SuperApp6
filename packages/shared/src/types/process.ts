// ============================================================
// Processes — нодовый движок бизнес-процессов (Фаза 1)
// Документ-канвас = единственный источник правды (канвас лишь рисует его).
// Формат — плоский список нод + явный список рёбер (LLM-readable by design).
// ============================================================

/** Поле анкеты процесса (одна анкета на инстанс — модель Kissflow, без языка переменных). */
export interface ProcessFormField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'select';
  required?: boolean;
  /** Для type='select'. */
  options?: string[];
}

/** Нода канвас-документа. config — именованные значения по схеме типа ноды (НЕ позиционные). */
export interface ProcessNode {
  /** Семантический id ('find_machine') — стабильный ключ рёбер и истории шагов. */
  id: string;
  /** Тип из реестра нод ('start' | 'human.task' | 'condition' | 'notify' | 'end' | …). */
  type: string;
  label?: string;
  note?: string;
  config: Record<string, unknown>;
  /** Только для канваса; движок и валидация позиции игнорируют. */
  position?: { x: number; y: number };
}

/**
 * Ребро: из выходного порта (`fromPort`, по умолчанию 'main') одной ноды в входной
 * порт (`toPort`, по умолчанию 'main') другой. Порт 'main' = поток токенов; типизированные
 * порты (ai_model/ai_memory/ai_tool) = подключение под-ноды к агенту (n8n cluster-модель).
 */
export interface ProcessEdge {
  id: string;
  from: string;
  fromPort?: string;
  to: string;
  toPort?: string;
}

/** Канвас-документ процесса. */
export interface ProcessDocument {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  form: ProcessFormField[];
}

// ---------- Паспорт типа ноды (палитра; machine-readable — будущие AI-инструменты) ----------

/** Тип порта: 'main' = поток токенов; ai_* = подключение под-ноды к агенту (cluster-модель n8n). */
export type ProcessPortType = 'main' | 'ai_model' | 'ai_memory' | 'ai_tool' | 'ai_output';

export interface ProcessNodeOutput {
  key: string;
  label: string;
  /** Тип порта (по умолчанию 'main'). */
  type?: ProcessPortType;
}

/** Входной порт ноды. Агент имеет main (поток) + типизированные (model/memory/tool). */
export interface ProcessNodeInput {
  key: string;
  label?: string;
  type: ProcessPortType;
  /** Можно подключить несколько под-нод (порт инструментов агента). */
  multi?: boolean;
}

/** Поле конфигурации ноды — декларативный виджет формы (модель n8n properties / ComfyUI widgets). */
export interface ProcessNodeField {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'member' | 'department' | 'credential' | 'formField';
  required?: boolean;
  placeholder?: string;
  /** Для kind='select'. */
  options?: { value: string; label: string }[];
  /** Подсказка под полем (подстановки `{{form.поле}}` и т.п.). */
  help?: string;
  /** Поле показывается, только если другое поле равно одному из значений. */
  showIf?: { field: string; in: string[] };
}

export type ProcessNodeCategory = 'trigger' | 'flow' | 'people' | 'service' | 'ai' | 'integration';

/** Сериализованный паспорт типа ноды — то, что видит палитра канваса (и позже AI/MCP). */
export interface ProcessNodeTypeDto {
  type: string;
  title: string;
  description: string;
  category: ProcessNodeCategory;
  icon: string;
  /** system-ноды видны только платформенной роли (platform_admin). */
  tier: 'standard' | 'system';
  outputs: ProcessNodeOutput[];
  /** Входные порты. По умолчанию (если не задано) — один main-вход; у старта/под-нод — пусто. */
  inputs?: ProcessNodeInput[];
  terminal?: boolean;
  /**
   * Триггер-нода — точка входа процесса (модель n8n: фиксированного «Старт» нет).
   * Без входного порта, можно несколько, удаляется; публикация требует ≥1 триггера.
   */
  trigger?: boolean;
  /** Выход «main» может вести к нескольким нодам (Развилка) — редактор разрешает множественные связи. */
  multiOut?: boolean;
  /** Слияние — несколько входящих веток (для отрисовки/подсказок). */
  join?: boolean;
  /** Под-нода (Модель/Память/Инструмент) — подключается к агенту, не участвует в потоке токенов. */
  subNode?: boolean;
  fields: ProcessNodeField[];
}

// ---------- Статусы ----------

export type ProcessVersionStatus = 'draft' | 'published' | 'superseded';
export type ProcessInstanceStatus = 'running' | 'done' | 'cancelled' | 'error';
export type ProcessStepStatus = 'active' | 'done' | 'error' | 'cancelled';
export type ProcessVisibility = 'team' | 'admins';

// ---------- Валидация / DTO ----------

export interface ProcessValidationIssue {
  nodeId?: string;
  edgeId?: string;
  field?: string;
  message: string;
}

export interface ProcessDefinitionDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  visibility: ProcessVisibility;
  status: 'active' | 'archived';
  /** Есть ли опубликованная (запускаемая) версия. */
  hasPublished: boolean;
  publishedVersion: number | null;
  latestVersion: number;
  latestVersionStatus: ProcessVersionStatus;
  runningCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessVersionMetaDto {
  id: string;
  version: number;
  status: ProcessVersionStatus;
  publishedAt: string | null;
}

/** Сводка по триггер-ноде (синхронизируется в ProcessTrigger при публикации). */
export interface ProcessTriggerNodeInfo {
  /** id триггер-ноды на канвасе. */
  nodeId: string;
  type: 'schedule' | 'webhook' | 'event' | 'telegram';
  enabled: boolean;
  /** Полный публичный URL (только для webhook-триггера; появляется после публикации). */
  webhookUrl: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface ProcessDefinitionDetailDto extends ProcessDefinitionDto {
  /** Документ редактируемой (последней) версии. */
  document: ProcessDocument;
  /** Анкета ОПУБЛИКОВАННОЙ версии (модалка запуска показывает то, что провалидирует сервер). */
  startForm: ProcessFormField[] | null;
  /** Триггер-ноды опубликованной версии (для показа webhook-URL/статуса в панели ноды). */
  triggers: ProcessTriggerNodeInfo[];
  editableVersion: number;
  editableVersionStatus: ProcessVersionStatus;
  versions: ProcessVersionMetaDto[];
  /** Мягкая валидация текущего документа (публикацию блокирует, сохранение — нет). */
  issues: ProcessValidationIssue[];
  canEdit: boolean;
  canStart: boolean;
}

export interface ProcessUserMini {
  id: string;
  firstName: string;
  lastName: string | null;
}

export interface ProcessStepDto {
  id: string;
  nodeId: string;
  nodeType: string;
  /** Подпись ноды из документа закреплённой версии. */
  label: string;
  status: ProcessStepStatus;
  startedAt: string;
  completedAt: string | null;
  /** «Секундомер»: сколько шаг занял (null, пока активен). */
  durationMs: number | null;
  outcome: string | null;
  error: string | null;
  taskId: string | null;
  assignee: ProcessUserMini | null;
  // Ф2:
  departmentId: string | null;
  departmentName: string | null;
  /** Дедлайн SLA / время побудки паузы. */
  deadlineAt: string | null;
  /** Шаг просрочен (дедлайн прошёл, шаг ещё активен). */
  overdue: boolean;
  decision: 'approved' | 'rejected' | null;
  /** Зритель может забрать эту задачу отдела из очереди. */
  canClaim: boolean;
  /** Зритель может вынести решение по этому одобрению. */
  canDecide: boolean;
  /** Зритель (manager+) может переназначить исполнителя этого шага. */
  canReassign: boolean;
}

export interface ProcessInstanceDto {
  id: string;
  definitionId: string;
  definitionName: string;
  version: number;
  workspaceId: string;
  status: ProcessInstanceStatus;
  error: string | null;
  startedBy: ProcessUserMini;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Подписи активных шагов («где сейчас токен») — для списка. */
  currentSteps: string[];
}

export interface ProcessInstanceDetailDto extends ProcessInstanceDto {
  /** Анкета процесса (значения стартовой формы). */
  variables: Record<string, unknown>;
  /** Документ закреплённой версии (read-only канвас со статусами шагов). */
  document: ProcessDocument;
  steps: ProcessStepDto[];
  canCancel: boolean;
}

// ---------- Ф2: «Входящие» (мой инбокс процессов) ----------

export interface ProcessInboxItem {
  /** claim — забрать задачу отдела; approve — вынести решение по одобрению. */
  kind: 'claim' | 'approve';
  instanceId: string;
  stepId: string;
  processName: string;
  /** Подпись шага. */
  title: string;
  /** Текст (название будущей задачи / вопрос одобрения). */
  detail: string | null;
  departmentName: string | null;
  startedBy: ProcessUserMini;
  createdAt: string;
  deadlineAt: string | null;
  overdue: boolean;
}

// ---------- Ф2: отчёт «время по шагам/отделам» ----------

export interface ProcessReportRow {
  nodeId: string;
  label: string;
  nodeType: string;
  departmentName: string | null;
  /** Сколько завершённых шагов этой ноды учтено. */
  count: number;
  avgMs: number;
  maxMs: number;
  totalMs: number;
}

export interface ProcessReportDto {
  definitionId: string;
  definitionName: string;
  /** Завершённых инстансов учтено. */
  finishedInstances: number;
  /** Среднее время прохождения всего процесса (старт→финиш). */
  avgCycleMs: number | null;
  rows: ProcessReportRow[];
}

// ---------- Ф3: триггеры запуска ----------

export type ProcessTriggerType = 'event' | 'schedule' | 'webhook';

export interface ProcessTriggerDto {
  id: string;
  type: ProcessTriggerType;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Полный URL вебхука (только для type='webhook'). */
  webhookUrl: string | null;
  runAs: ProcessUserMini | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

// ---------- Ф3: сейф кредов ----------

export type ProcessCredentialType = 'header' | 'basic' | 'bearer';

/** Креды БЕЗ секрета (секрет наружу не отдаётся). */
export interface ProcessCredentialDto {
  id: string;
  name: string;
  type: ProcessCredentialType;
  createdAt: string;
}
