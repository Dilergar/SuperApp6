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
  /**
   * Выход, который МОЖНО оставить неподключённым (валидация не требует связи).
   * Нужен, чтобы добавлять исходы к уже опубликованным нодам, не ломая
   * нарисованные маршруты: у согласования появился третий исход «На доработку»,
   * и без этого флага каждая существующая нода «Одобрение» стала бы невалидной.
   * В рантайме токен из неподключённого выхода уходит по запасному (см. fallbackOutput).
   */
  optional?: boolean;
  /** Куда уходит токен, если этот выход никуда не ведёт (обратная совместимость). */
  fallback?: string;
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
  kind: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'member' | 'department' | 'position' | 'branch' | 'credential' | 'formField';
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
  /**
   * Семантический ключ иконки из реестра клиента (`ICONS` веб-кита): 'play',
   * 'clock', 'robot'… Эмодзи здесь ЗАПРЕЩЕНЫ (DESIGN.md §3: интерфейсная
   * иконка — Phosphor Light, эмодзи остаются только у пользовательских данных).
   * Неизвестный клиенту ключ рисуется запасной иконкой, а не ломает палитру.
   */
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
  /**
   * В каких ПРОФИЛЯХ редактора нода видна. Пусто — во всех (общий канвас Процессов).
   *
   * Профиль приходит от предметной области: кадровик, рисующий маршрут документа,
   * не должен видеть ноды про счета и AI-агентов, а бухгалтер — про личное дело.
   * Ключ профиля = категория вида документа ('documents.hr', 'documents.general'),
   * поэтому новая область — это строка, а не правка палитры.
   */
  surfaces?: string[];
  fields: ProcessNodeField[];
}

/**
 * Профили редактора маршрутов. `general` — полный канвас Процессов (всё, что есть).
 * Остальные — урезанные наборы под конкретную работу.
 */
export const PROCESS_SURFACES = ['general', 'documents.hr', 'documents.general'] as const;
export type ProcessSurface = (typeof PROCESS_SURFACES)[number];

/**
 * Что показывает УРЕЗАННЫЙ редактор. Белый список, а не чёрный: любая новая нода
 * платформы (интеграция, AI, коннектор) по умолчанию НЕ попадает к кадровику —
 * иначе «урезанный редактор» перестанет быть урезанным на третьем же релизе.
 *
 * `general` здесь отсутствует намеренно: это полный канвас Процессов, там видно всё.
 */
export const SURFACE_NODE_TYPES: Record<string, readonly string[]> = {
  'documents.hr': [
    'trigger.document',
    'human.approval', // согласование · подпись · ознакомление — вид выбирается в ноде
    'doc.generate',
    'doc.register',
    'doc.file',
    // КЭДО: применить кадровое действие / поставить сдачу в ЕСУТД — правило
    // платформы «всё, что делает система, стоит нодой на канвасе»
    'hr.apply',
    'hr.esutd',
    'condition',
    'notify',
    'delay',
    'parallel.split',
    'parallel.join',
    'end',
  ],
  'documents.general': [
    'trigger.document',
    'human.approval',
    'human.task',
    'doc.generate',
    'doc.register',
    'condition',
    'notify',
    'delay',
    'parallel.split',
    'parallel.join',
    'end',
  ],
};

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
  /**
   * `error` — публиковать нельзя (маршрут физически не соберётся).
   * `warning` — соберётся, но нарушает правило предметной области: по ТК РК с
   * приказом нужно ознакомить сотрудника, номер обязан присваиваться и т.д.
   *
   * Разделение появилось вместе с кадровыми маршрутами: правила закона мы знаем
   * лучше кадровика, но запрещать ими публикацию нельзя — у компании может быть
   * законная причина сделать иначе, и сервис, который в такой момент говорит
   * «нельзя», выключают целиком. Поэтому предупреждение принимается ЯВНО, и в
   * журнал попадает, кто и когда взял риск на себя.
   *
   * Отсутствие поля читается как `error` — старые сохранённые issues и любой
   * забытый вызов остаются блокирующими (fail-closed).
   */
  severity?: 'error' | 'warning';
  /** Ключ правила (для «Понимаю, публикую» и отметки в журнале) */
  ruleKey?: string;
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
  /**
   * Мягкая валидация текущего документа. `severity:'error'` блокирует публикацию,
   * `'warning'` (правила предметной области) — требует явного «Понимаю, публикую».
   */
  issues: ProcessValidationIssue[];
  /** Профиль редактора: какой набор нод показывать и какие правила проверять. */
  surface: string;
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

/**
 * Тонкий статус инстанса (P7): только волатильные поля для 4с-поллинга — без документа
 * и анкеты (их фронт тянет один раз через getInstance). Обновления берутся отсюда.
 */
export interface ProcessInstanceStatusDto {
  id: string;
  status: ProcessInstanceStatus;
  error: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  currentSteps: string[];
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

// ---------- Ф3: сейф кредов ----------

export type ProcessCredentialType = 'header' | 'basic' | 'bearer';

/** Креды БЕЗ секрета (секрет наружу не отдаётся). */
export interface ProcessCredentialDto {
  id: string;
  name: string;
  type: ProcessCredentialType;
  createdAt: string;
}
