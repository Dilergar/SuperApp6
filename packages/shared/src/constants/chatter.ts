// ============================================================
// core/chatter («Хроника записи») — константы
// Универсальная лента «кто/что/когда + было → стало» на любой сущности
// (refType+refId). Реестр типов записей — как NOTIFICATION_REGISTRY:
// один источник шаблонов для API (плашки в чат) и веба (журнал).
// ============================================================

/** Категории для фильтра «Журнала организации» */
export const CHATTER_CATEGORIES = ['tasks', 'staff', 'hr', 'drive', 'share', 'documents', 'processes', 'objects', 'notes', 'visibility'] as const;
export type ChatterCategory = (typeof CHATTER_CATEGORIES)[number];

export interface ChatterTypeMeta {
  icon: string;
  category: ChatterCategory;
  /** Проецировать плашкой в контекстный чат сущности (если у refType зарегистрирован chat-sink) */
  chatPost: boolean;
}

// СЛОВА живут в каталоге `@superapp/i18n` — `chatter.type.<typeKey>`; здесь реестр
// называет СМЫСЛ: иконка, категория журнала и «проецировать ли плашкой в чат».
// Текст записи собирается ПРИ ЧТЕНИИ в языке зрителя (renderChatter), поэтому
// накопленная за годы хроника переводится вместе с каталогом, а не остаётся
// навсегда на языке того дня, когда её записали.
export const CHATTER_REGISTRY = {
  // ---- Задачи (refType='task'; typeKey = eventType плашки в чате задачи) ----
  'task.created': {
    icon: '🆕',
    category: 'tasks',
    chatPost: false, // сегодня плашки нет — не спамим само-задачи
  },
  'task.assigned': {
    icon: '👤',
    category: 'tasks',
    chatPost: true,
  },
  'task.submitted': {
    icon: '📤',
    category: 'tasks',
    chatPost: true,
  },
  'task.accepted': {
    icon: '✅',
    category: 'tasks',
    chatPost: true,
  },
  'task.returned': {
    icon: '↩️',
    category: 'tasks',
    chatPost: true,
  },
  'task.completed': {
    icon: '🎉',
    category: 'tasks',
    chatPost: true,
  },
  // Движок документов: вложение стало ОБЩИМ редактируемым документом. Это явный акт
  // человека, и участники места обязаны его увидеть — оживление раздаёт право правки
  // всем, кто может писать в это место.
  'task.document_created': {
    icon: '📄',
    category: 'tasks',
    chatPost: true,
  },
  /**
   * Заход правки закончился (вышел последний редактор). Пишется ОДИН РАЗ НА ЗАХОД, а не
   * на каждое сохранение: редактор сохраняет примерно раз в полминуты, и запись на
   * каждое превратила бы чат в ленту «правил… правил… правил…».
   */
  'task.document_edited': {
    icon: '✏️',
    category: 'tasks',
    chatPost: true,
  },
  /** То же самое, но в хронике САМОГО документа — она есть и у файла без задачи и чата */
  'document.edited': {
    icon: '✏️',
    category: 'tasks',
    chatPost: false,
  },
  'document.version_saved': {
    icon: '🔖',
    category: 'tasks',
    chatPost: false,
  },
  'document.restored': {
    icon: '↩️',
    category: 'tasks',
    chatPost: false,
  },
  'document.created': {
    icon: '📄',
    category: 'tasks',
    chatPost: false,
  },
  'task.cancelled': {
    icon: '🚫',
    category: 'tasks',
    chatPost: true,
  },
  'task.deadline_changed': {
    icon: '📅',
    category: 'tasks',
    chatPost: true,
  },
  'task.priority_changed': {
    icon: '⚡',
    category: 'tasks',
    chatPost: true,
  },
  'task.reward_changed': {
    icon: '🪙',
    category: 'tasks',
    chatPost: true,
  },
  'task.title_changed': {
    icon: '✏️',
    category: 'tasks',
    chatPost: true,
  },
  'task.description_changed': {
    icon: '📝',
    category: 'tasks',
    chatPost: true,
  },
  'task.participant_added': {
    icon: '➕',
    category: 'tasks',
    chatPost: true,
  },
  'task.participant_removed': {
    icon: '➖',
    category: 'tasks',
    chatPost: true,
  },

  // ---- Организация (refType='workspace', refId=workspaceId; поверхность — «Журнал», в чат не постятся) ----
  'staff.invited': {
    icon: '✉️',
    category: 'staff',
    chatPost: false,
  },
  'staff.hired': {
    icon: '🤝',
    category: 'staff',
    chatPost: false,
  },
  'staff.fired': {
    icon: '🚪',
    category: 'staff',
    chatPost: false,
  },
  'staff.left': {
    icon: '🚪',
    category: 'staff',
    chatPost: false,
  },
  'staff.role_changed': {
    icon: '🎖️',
    category: 'staff',
    chatPost: false,
  },
  'staff.ownership_transferred': {
    icon: '👑',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_assigned': {
    // {{branchClause}} выводится рендером из сырого payload.branchName (презентация
    // не запекается в вечную строку — формат можно поменять без миграции данных).
    icon: '💼',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_updated': {
    icon: '🔀',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_certified': {
    icon: '🎓',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_removed': {
    icon: '📤',
    category: 'staff',
    chatPost: false,
  },

  // ---- Юрлица организации (refType='workspace') ----
  'legal_entity.created': {
    icon: '🏛️',
    category: 'objects',
    chatPost: false,
  },
  'legal_entity.updated': {
    icon: '🏛️',
    category: 'objects',
    chatPost: false,
  },
  'legal_entity.archived': {
    icon: '📦',
    category: 'objects',
    chatPost: false,
  },

  // ---- Объекты (refType='branch', refId=branchId) ----
  'branch.created': {
    icon: '🏬',
    category: 'objects',
    chatPost: false,
  },
  'branch.updated': {
    icon: '✏️',
    category: 'objects',
    chatPost: false,
  },
  'branch.moved': {
    icon: '🔀',
    category: 'objects',
    chatPost: false,
  },
  'branch.archived': {
    icon: '📦',
    category: 'objects',
    chatPost: false,
  },
  'branch.head_set': {
    icon: '⭐',
    category: 'objects',
    chatPost: false,
  },
  'branch.legal_entity_set': {
    icon: '🏛️',
    category: 'objects',
    chatPost: false,
  },

  // ---- Штатное расписание (refType='branch') ----
  'staffing.unit_created': {
    icon: '🧾',
    category: 'objects',
    chatPost: false,
  },
  'staffing.unit_updated': {
    icon: '🧾',
    category: 'objects',
    chatPost: false,
  },
  'staffing.unit_archived': {
    icon: '🗑️',
    category: 'objects',
    chatPost: false,
  },
  'staffing.assigned': {
    icon: '💼',
    category: 'objects',
    chatPost: false,
  },
  'staffing.closed': {
    icon: '📤',
    category: 'objects',
    chatPost: false,
  },
  'staffing.assignment_updated': {
    icon: '🗓️',
    category: 'objects',
    chatPost: false,
  },
  'staffing.rate_set': {
    icon: '💰',
    category: 'objects',
    chatPost: false,
  },

  // ---- График смен (refType='branch') ----
  'shift.created': {
    icon: '🗓️',
    category: 'objects',
    chatPost: false,
  },
  'shift.assigned': {
    icon: '🧑‍🍳',
    category: 'objects',
    chatPost: false,
  },
  'shift.unassigned': {
    icon: '↩️',
    category: 'objects',
    chatPost: false,
  },
  'shift.published': {
    icon: '📣',
    category: 'objects',
    chatPost: false,
  },
  'shift.cancelled': {
    icon: '🚫',
    category: 'objects',
    chatPost: false,
  },
  'shift.taken': {
    icon: '🙋',
    category: 'objects',
    chatPost: false,
  },
  'shift.forced': {
    icon: '⚠️',
    category: 'objects',
    chatPost: false,
  },
  'attendance.marked': {
    icon: '✅',
    category: 'objects',
    chatPost: false,
  },
  'attendance.removed': {
    icon: '🗑️',
    category: 'objects',
    chatPost: false,
  },

  // ---- Оборудование (refType='asset', refId=assetId) ----
  'asset.created': {
    icon: '🔧',
    category: 'objects',
    chatPost: false,
  },
  'asset.updated': {
    icon: '✏️',
    category: 'objects',
    chatPost: false,
  },
  'asset.moved': {
    icon: '🚚',
    category: 'objects',
    chatPost: false,
  },
  'asset.custodian_set': {
    icon: '🙋',
    category: 'objects',
    chatPost: false,
  },
  'asset.holding_set': {
    icon: '🏛️',
    category: 'objects',
    chatPost: false,
  },
  'asset.status_set': {
    icon: '🔁',
    category: 'objects',
    chatPost: false,
  },
  'asset.service_logged': {
    icon: '🛠️',
    category: 'objects',
    chatPost: false,
  },

  // ---- Оргструктура (refType='workspace'; след в «Журнале», приказа на структуру нет) ----
  // Появление и исчезновение единиц структуры. Раньше в журнал не попадало вообще:
  // назначения писались, а удаление целого отдела — нет, и кадровый аудит обрывался
  // ровно там, где вопрос «куда делся отдел» и возникает. `unitLabel` — «отдел» /
  // «должность» / «объект» (презентация не запекается в вечную запись отдельным ключом).
  'staff.unit_created': {
    icon: '🧩',
    category: 'staff',
    chatPost: false,
  },
  'staff.unit_deleted': {
    icon: '🗑️',
    category: 'staff',
    chatPost: false,
  },
  'staff.head_set': {
    // payload: departmentName, positionName (null → «снята»)
    icon: '🧭',
    category: 'staff',
    chatPost: false,
  },
  'staff.branch_head_set': {
    icon: '🏬',
    category: 'staff',
    chatPost: false,
  },
  'staff.reports_to_set': {
    icon: '🔗',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_moved': {
    icon: '📦',
    category: 'staff',
    chatPost: false,
  },
  'staff.deputy_opened': {
    // payload: positionName, deputyLabel (должность или человек), periodLabel
    icon: '🔁',
    category: 'staff',
    chatPost: false,
  },
  'staff.deputy_closed': {
    icon: '⏹️',
    category: 'staff',
    chatPost: false,
  },
  'staff.primary_changed': {
    icon: '📌',
    category: 'staff',
    chatPost: false,
  },
  'staff.default_branch_changed': {
    icon: '🏠',
    category: 'staff',
    chatPost: false,
  },

  // ---- Диск (refType='drive_node') ----
  // Контекстного чата у узла Диска нет, поэтому chatPost везде false: хроника
  // читается на самом объекте и в «Журнале организации».
  'drive.created': {
    icon: '📄',
    category: 'drive',
    chatPost: false,
  },
  'drive.renamed': {
    icon: '✏️',
    category: 'drive',
    chatPost: false,
  },
  'drive.moved': {
    icon: '📁',
    category: 'drive',
    chatPost: false,
  },
  'drive.shared': {
    icon: '🔓',
    category: 'drive',
    chatPost: false,
  },
  // ---- Сервис «Документы»: хроника КАРТОЧКИ документа ----
  // Она же — доказательство при проверке: кто создал, кто отправил, кто подписал,
  // когда присвоен номер. Поэтому пишется в транзакции самого действия, а не «потом».
  'org_document.created': {
    icon: '📄',
    category: 'documents',
    chatPost: false,
  },
  'org_document.submitted': {
    icon: '📤',
    category: 'documents',
    chatPost: false,
  },
  'org_document.approved': {
    icon: '✅',
    category: 'documents',
    chatPost: false,
  },
  'org_document.signed': {
    icon: '🖊️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.rejected': {
    icon: '⛔',
    category: 'documents',
    chatPost: false,
  },
  'org_document.returned': {
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.registered': {
    icon: '🔢',
    category: 'documents',
    chatPost: false,
  },
  'org_document.filed': {
    icon: '🗂️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.cancelled': {
    icon: '🚫',
    category: 'documents',
    chatPost: false,
  },
  // Возврат С МАРШРУТА в черновик — не отмена: документ жив, его просто дорабатывают.
  'org_document.withdrawn': {
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  // ---- Внешний этап (категория «С контрагентами») ----
  'org_document.sent_external': {
    icon: '📨',
    category: 'documents',
    chatPost: false,
  },
  'org_document.counterparty_signed': {
    icon: '🖊️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.counterparty_declined': {
    icon: '⛔',
    category: 'documents',
    chatPost: false,
  },
  'org_document.external_revoked': {
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.external_expired': {
    icon: '⌛',
    category: 'documents',
    chatPost: false,
  },
  // Возврат в работу ПОСЛЕ ОТКАЗА контрагента — не «отозвали с маршрута»:
  // причина возврата должна читаться из самой записи, без археологии по соседним.
  'org_document.external_returned': {
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  // ---- Сервис «Контрагенты»: хроника карточки справочника ----
  'counterparty.restored': {
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.created': {
    icon: '🏢',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.updated': {
    icon: '✏️',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.archived': {
    icon: '📦',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.contact_added': {
    icon: '👤',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.contact_removed': {
    icon: '👤',
    category: 'documents',
    chatPost: false,
  },
  'drive.unshared': {
    icon: '🔒',
    category: 'drive',
    chatPost: false,
  },
  'drive.trashed': {
    icon: '🗑️',
    category: 'drive',
    chatPost: false,
  },
  'drive.restored': {
    icon: '♻️',
    category: 'drive',
    chatPost: false,
  },
  'drive.version_saved': {
    icon: '🗂️',
    category: 'drive',
    chatPost: false,
  },
  'drive.version_restored': {
    icon: '↩️',
    category: 'drive',
    chatPost: false,
  },

  // ---- Гостевые ссылки (core/share-links; refType = объект, на который выдана ссылка) ----
  // Своя категория, а не 'drive': ссылки наружу выдаются и на документы, а завтра
  // на счета и витрины — в журнале организации это отдельная строка фильтра.
  // Раздача доступа ВНЕ платформы не должна происходить тихо, поэтому запись есть
  // всегда, даже когда у объекта нет контекстного чата (chatPost: false).
  'share.link_created': {
    icon: '🔗',
    category: 'share',
    chatPost: false,
  },
  'share.link_revoked': {
    icon: '⛔',
    category: 'share',
    chatPost: false,
  },
  // Смена адреса — тоже изменение доступа наружу: у части получателей он в этот момент
  // пропадает, поэтому событие стоит рядом с выдачей и отзывом, а не прячется в правку.
  'share.link_rotated': {
    icon: '🔄',
    category: 'share',
    chatPost: false,
  },

  // ---- Процессы (refType='workspace' — запись журнала организации) ----
  // Маршрут опубликован ВОПРЕКИ предупреждениям правил кадрового учёта. Проверка
  // их не блокирует (закон меняется чаще кода, и запрет остановил бы работу), но
  // «Понимаю, публикую» — это принятый риск, и у него должен быть автор и дата.
  // Правила перечисляются поимённо: через год важно не «были предупреждения», а
  // КАКИЕ именно проигнорировали.
  'process.published_with_warnings': {
    icon: '⚠️',
    category: 'processes',
    chatPost: false,
  },

  // ---- КЭДО (modules/hr; refType='hr_member', refId=`<wsId>:<userId>` —
  // хроника вкладки «Хроника» на странице человека; workspaceId у записи
  // заполнен, поэтому она же видна в «Журнале организации» фильтром «Кадры») ----
  'hr.employment_created': {
    icon: '📇',
    category: 'hr',
    chatPost: false,
  },
  'hr.employment_updated': {
    icon: '📇',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_created': {
    icon: '🧾',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_applied': {
    icon: '✅',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_failed': {
    icon: '⚠️',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_cancelled': {
    icon: '🚫',
    category: 'hr',
    chatPost: false,
  },
  'hr.delivery_fixed': {
    icon: '📬',
    category: 'hr',
    chatPost: false,
  },
  // Акт РАБОТОДАТЕЛЯ на кадровом документе подписан ЭЦП физлица (в сертификате
  // нет БИН юрлица) — предупреждение, не отказ (v1; жёсткость — после юриста).
  // Свой ключ, а не hr.action_failed: «не применено» рядом с настоящими
  // отказами применения вводило бы в заблуждение — действие как раз применилось.
  'hr.sign_bin_warning': {
    icon: '🖋️',
    category: 'hr',
    chatPost: false,
  },
  'hr.esutd_submitted': {
    icon: '🏛️',
    category: 'hr',
    chatPost: false,
  },
  'hr.campaign_started': {
    icon: '📢',
    category: 'hr',
    chatPost: false,
  },
  'hr.campaign_acknowledged': {
    icon: '👁️',
    category: 'hr',
    chatPost: false,
  },
  'hr.library_installed': {
    icon: '📚',
    category: 'hr',
    chatPost: false,
  },
  // ---- Заметки (refType='note' и 'note_folder'; текст правок в хронику НЕ пишется — только метаданные) ----
  'note.created': { icon: '📝', category: 'notes', chatPost: false },
  'note.renamed': { icon: '✏️', category: 'notes', chatPost: false },
  'note.moved': { icon: '📁', category: 'notes', chatPost: false },
  'note.shared': { icon: '🔓', category: 'notes', chatPost: false },
  'note.unshared': { icon: '🔒', category: 'notes', chatPost: false },
  'note.trashed': { icon: '🗑️', category: 'notes', chatPost: false },
  'note.restored': { icon: '♻️', category: 'notes', chatPost: false },
  'note.related': { icon: '🔗', category: 'notes', chatPost: false },
  'note.unrelated': { icon: '🔗', category: 'notes', chatPost: false },
  // Папка — отдельные ключи: у неё своя лента (refType note_folder), и события заметки
  // на ней читались как «создал(а) заметку «Клиенты»».
  'note.folder.created': { icon: '📁', category: 'notes', chatPost: false },
  'note.folder.renamed': { icon: '✏️', category: 'notes', chatPost: false },
  'note.folder.moved': { icon: '📁', category: 'notes', chatPost: false },
  'note.folder.shared': { icon: '🔓', category: 'notes', chatPost: false },
  'note.folder.unshared': { icon: '🔒', category: 'notes', chatPost: false },
  'note.folder.trashed': { icon: '🗑️', category: 'notes', chatPost: false },
  'note.folder.restored': { icon: '♻️', category: 'notes', chatPost: false },
  // ---- Правила видимости (core/visibility; refType='visibility_policy', refId = организация) ----
  'visibility_policy.published': { icon: '👁️', category: 'visibility', chatPost: false },
} as const satisfies Record<string, ChatterTypeMeta>;

export type ChatterTypeKey = keyof typeof CHATTER_REGISTRY;

/** typeKeys категории (фильтр журнала: category → typeKey IN (...)) */
export function chatterTypeKeysOf(category: ChatterCategory): string[] {
  return Object.entries(CHATTER_REGISTRY)
    .filter(([, meta]) => meta.category === category)
    .map(([key]) => key);
}

export const CHATTER_LIMITS = {
  pageSize: 30,
  maxPageSize: 100,
  /** Батч бэкфилла незапощенных плашек на bootstrap (деплой-переход на core/jobs). */
  chatPostBatch: 100,
  /**
   * Потолок попыток проекции плашки (maxAttempts джоба chatter.chatpost в core/jobs):
   * после N безуспешных — dead-letter движка (не вечный цикл).
   */
  chatPostMaxAttempts: 8,
  /**
   * Окно бэкфилла на bootstrap: незапощенные записи старше — не догоняем (иначе
   * поздняя регистрация синка вылила бы в чат всю накопленную историю залпом).
   * Штатный путь — джоб, поставленный в транзакции самой записи.
   */
  redriveMaxAgeSec: 86_400,
} as const;
