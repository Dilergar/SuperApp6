// ============================================================
// core/chatter («Хроника записи») — константы
// Универсальная лента «кто/что/когда + было → стало» на любой сущности
// (refType+refId). Реестр типов записей — как NOTIFICATION_REGISTRY:
// один источник шаблонов для API (плашки в чат) и веба (журнал).
// ============================================================

import { interpolateTemplate } from '../utils/interpolate';

/** Категории для фильтра «Журнала организации» */
export const CHATTER_CATEGORIES = ['tasks', 'staff', 'hr', 'drive', 'share', 'documents', 'processes'] as const;
export type ChatterCategory = (typeof CHATTER_CATEGORIES)[number];

export interface ChatterTypeMeta {
  /**
   * Шаблон текста для renderChatterText. Плейсхолдеры {{...}}:
   * actorName (фолбэк «Кто-то»), from/to (из changes[0]) + любые ключи payload
   * (targetName, roleLabel, positionName, branchSuffix…).
   */
  template: string;
  icon: string;
  category: ChatterCategory;
  /** Проецировать плашкой в контекстный чат сущности (если у refType зарегистрирован chat-sink) */
  chatPost: boolean;
}

// ВАЖНО (паритет плашек): шаблоны task.assigned/submitted/accepted/returned/completed
// байт-в-байт повторяют тексты удалённого TaskSystemListener — веб-рендер плашек не меняется.
export const CHATTER_REGISTRY = {
  // ---- Задачи (refType='task'; typeKey = eventType плашки в чате задачи) ----
  'task.created': {
    template: '{{actorName}} создал(а) задачу',
    icon: '🆕',
    category: 'tasks',
    chatPost: false, // сегодня плашки нет — не спамим само-задачи
  },
  'task.assigned': {
    template: '{{actorName}} назначил(а) задачу',
    icon: '👤',
    category: 'tasks',
    chatPost: true,
  },
  'task.submitted': {
    template: '{{actorName}} сдал(а) работу на проверку',
    icon: '📤',
    category: 'tasks',
    chatPost: true,
  },
  'task.accepted': {
    template: 'Работа принята',
    icon: '✅',
    category: 'tasks',
    chatPost: true,
  },
  'task.returned': {
    template: 'Работа возвращена на доработку',
    icon: '↩️',
    category: 'tasks',
    chatPost: true,
  },
  'task.completed': {
    template: 'Задача выполнена',
    icon: '🎉',
    category: 'tasks',
    chatPost: true,
  },
  // Движок документов: вложение стало ОБЩИМ редактируемым документом. Это явный акт
  // человека, и участники места обязаны его увидеть — оживление раздаёт право правки
  // всем, кто может писать в это место.
  'task.document_created': {
    template: '{{actorName}} открыл(а) файл «{{title}}» для совместного редактирования',
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
    template: '{{actorName}} правил(а) документ «{{title}}» ({{period}})',
    icon: '✏️',
    category: 'tasks',
    chatPost: true,
  },
  /** То же самое, но в хронике САМОГО документа — она есть и у файла без задачи и чата */
  'document.edited': {
    template: '{{actorName}} правил(а) документ ({{period}})',
    icon: '✏️',
    category: 'tasks',
    chatPost: false,
  },
  'document.version_saved': {
    template: '{{actorName}} сохранил(а) версию {{versionNo}}',
    icon: '🔖',
    category: 'tasks',
    chatPost: false,
  },
  'document.restored': {
    template: '{{actorName}} вернул(а) версию {{versionNo}} как текущую',
    icon: '↩️',
    category: 'tasks',
    chatPost: false,
  },
  'document.created': {
    template: '{{actorName}} открыл(а) файл «{{title}}» для совместного редактирования',
    icon: '📄',
    category: 'tasks',
    chatPost: false,
  },
  'task.cancelled': {
    template: '{{actorName}} отменил(а) задачу',
    icon: '🚫',
    category: 'tasks',
    chatPost: true,
  },
  'task.deadline_changed': {
    template: '{{actorName}} изменил(а) срок: {{from}} → {{to}}',
    icon: '📅',
    category: 'tasks',
    chatPost: true,
  },
  'task.priority_changed': {
    template: '{{actorName}} изменил(а) приоритет: {{from}} → {{to}}',
    icon: '⚡',
    category: 'tasks',
    chatPost: true,
  },
  'task.reward_changed': {
    template: '{{actorName}} изменил(а) награду: {{from}} → {{to}}',
    icon: '🪙',
    category: 'tasks',
    chatPost: true,
  },
  'task.title_changed': {
    template: '{{actorName}} переименовал(а) задачу: «{{from}}» → «{{to}}»',
    icon: '✏️',
    category: 'tasks',
    chatPost: true,
  },
  'task.description_changed': {
    template: '{{actorName}} обновил(а) описание',
    icon: '📝',
    category: 'tasks',
    chatPost: true,
  },
  'task.participant_added': {
    template: '{{actorName}} добавил(а) {{targetName}} — {{roleLabel}}',
    icon: '➕',
    category: 'tasks',
    chatPost: true,
  },
  'task.participant_removed': {
    template: '{{actorName}} исключил(а) {{targetName}}',
    icon: '➖',
    category: 'tasks',
    chatPost: true,
  },

  // ---- Организация (refType='workspace', refId=workspaceId; поверхность — «Журнал», в чат не постятся) ----
  'staff.invited': {
    template: '{{actorName}} пригласил(а) {{targetName}} в организацию',
    icon: '✉️',
    category: 'staff',
    chatPost: false,
  },
  'staff.hired': {
    template: '{{actorName}} вступил(а) в организацию (Стажёр)',
    icon: '🤝',
    category: 'staff',
    chatPost: false,
  },
  'staff.fired': {
    template: '{{actorName}} уволил(а) {{targetName}}',
    icon: '🚪',
    category: 'staff',
    chatPost: false,
  },
  'staff.left': {
    template: '{{actorName}} покинул(а) организацию',
    icon: '🚪',
    category: 'staff',
    chatPost: false,
  },
  'staff.role_changed': {
    template: '{{actorName}} изменил(а) роль {{targetName}}: {{from}} → {{to}}',
    icon: '🎖️',
    category: 'staff',
    chatPost: false,
  },
  'staff.ownership_transferred': {
    template: '{{actorName}} передал(а) владение организацией — {{targetName}}',
    icon: '👑',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_assigned': {
    // {{branchClause}} выводится рендером из сырого payload.branchName (презентация
    // не запекается в вечную строку — формат можно поменять без миграции данных).
    template: '{{actorName}} назначил(а) {{targetName}} на должность «{{positionName}}»{{branchClause}}',
    icon: '💼',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_updated': {
    template: '{{actorName}} изменил(а) назначение {{targetName}} («{{positionName}}»): {{from}} → {{to}}',
    icon: '🔀',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_certified': {
    template: '{{targetName}} аттестован(а) по должности «{{positionName}}»',
    icon: '🎓',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_removed': {
    template: '{{actorName}} снял(а) {{targetName}} с должности «{{positionName}}»',
    icon: '📤',
    category: 'staff',
    chatPost: false,
  },

  // ---- Диск (refType='drive_node') ----
  // Контекстного чата у узла Диска нет, поэтому chatPost везде false: хроника
  // читается на самом объекте и в «Журнале организации».
  'drive.created': {
    template: '{{actorName}} добавил(а) «{{targetName}}»',
    icon: '📄',
    category: 'drive',
    chatPost: false,
  },
  'drive.renamed': {
    template: '{{actorName}} переименовал(а): «{{from}}» → «{{to}}»',
    icon: '✏️',
    category: 'drive',
    chatPost: false,
  },
  'drive.moved': {
    template: '{{actorName}} переместил(а) «{{targetName}}» в «{{to}}»',
    icon: '📁',
    category: 'drive',
    chatPost: false,
  },
  'drive.shared': {
    template: '{{actorName}} открыл(а) доступ к «{{targetName}}»: {{principalLabel}} — {{roleLabel}}',
    icon: '🔓',
    category: 'drive',
    chatPost: false,
  },
  // ---- Сервис «Документы»: хроника КАРТОЧКИ документа ----
  // Она же — доказательство при проверке: кто создал, кто отправил, кто подписал,
  // когда присвоен номер. Поэтому пишется в транзакции самого действия, а не «потом».
  'org_document.created': {
    template: '{{actorName}} создал(а) документ «{{title}}»',
    icon: '📄',
    category: 'documents',
    chatPost: false,
  },
  'org_document.submitted': {
    template: '{{actorName}} отправил(а) документ на маршрут',
    icon: '📤',
    category: 'documents',
    chatPost: false,
  },
  'org_document.approved': {
    template: 'Документ согласован',
    icon: '✅',
    category: 'documents',
    chatPost: false,
  },
  'org_document.signed': {
    template: 'Документ подписан',
    icon: '🖊️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.rejected': {
    template: 'Документ отклонён{{reasonSuffix}}',
    icon: '⛔',
    category: 'documents',
    chatPost: false,
  },
  'org_document.returned': {
    template: 'Документ отправлен на доработку{{reasonSuffix}}',
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.registered': {
    template: 'Документу присвоен номер {{number}}',
    icon: '🔢',
    category: 'documents',
    chatPost: false,
  },
  'org_document.filed': {
    template: 'Документ подшит: {{placeLabel}}',
    icon: '🗂️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.cancelled': {
    template: '{{actorName}} отменил(а) документ',
    icon: '🚫',
    category: 'documents',
    chatPost: false,
  },
  // Возврат С МАРШРУТА в черновик — не отмена: документ жив, его просто дорабатывают.
  'org_document.withdrawn': {
    template: '{{actorName}} вернул(а) документ в черновик',
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  // ---- Внешний этап (категория «С контрагентами») ----
  'org_document.sent_external': {
    template: '{{actorName}} отправил(а) документ контрагенту{{contactSuffix}}',
    icon: '📨',
    category: 'documents',
    chatPost: false,
  },
  'org_document.counterparty_signed': {
    template: 'Контрагент подписал документ{{signerSuffix}}',
    icon: '🖊️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.counterparty_declined': {
    template: 'Контрагент отказался подписывать{{reasonSuffix}}',
    icon: '⛔',
    category: 'documents',
    chatPost: false,
  },
  'org_document.external_revoked': {
    template: '{{actorName}} отозвал(а) отправку контрагенту',
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  'org_document.external_expired': {
    template: 'Срок подписания контрагентом истёк — документ вернулся в черновик',
    icon: '⌛',
    category: 'documents',
    chatPost: false,
  },
  // Возврат в работу ПОСЛЕ ОТКАЗА контрагента — не «отозвали с маршрута»:
  // причина возврата должна читаться из самой записи, без археологии по соседним.
  'org_document.external_returned': {
    template: '{{actorName}} вернул(а) документ в работу после отказа контрагента',
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  // ---- Сервис «Контрагенты»: хроника карточки справочника ----
  'counterparty.restored': {
    template: '{{actorName}} вернул(а) контрагента «{{name}}» из архива',
    icon: '↩️',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.created': {
    template: '{{actorName}} добавил(а) контрагента «{{name}}»',
    icon: '🏢',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.updated': {
    template: '{{actorName}} изменил(а) карточку контрагента',
    icon: '✏️',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.archived': {
    template: '{{actorName}} убрал(а) контрагента в архив',
    icon: '📦',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.contact_added': {
    template: '{{actorName}} добавил(а) контактное лицо {{contactName}}',
    icon: '👤',
    category: 'documents',
    chatPost: false,
  },
  'counterparty.contact_removed': {
    template: '{{actorName}} убрал(а) контактное лицо {{contactName}}',
    icon: '👤',
    category: 'documents',
    chatPost: false,
  },
  'drive.unshared': {
    template: '{{actorName}} закрыл(а) доступ к «{{targetName}}»: {{principalLabel}}',
    icon: '🔒',
    category: 'drive',
    chatPost: false,
  },
  'drive.trashed': {
    template: '{{actorName}} удалил(а) «{{targetName}}» в корзину',
    icon: '🗑️',
    category: 'drive',
    chatPost: false,
  },
  'drive.restored': {
    template: '{{actorName}} восстановил(а) «{{targetName}}»',
    icon: '♻️',
    category: 'drive',
    chatPost: false,
  },
  'drive.version_saved': {
    template: '{{actorName}} сохранил(а) версию {{versionNo}}',
    icon: '🗂️',
    category: 'drive',
    chatPost: false,
  },
  'drive.version_restored': {
    template: '{{actorName}} вернул(а) версию {{versionNo}}',
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
    template: '{{actorName}} создал(а) гостевую ссылку на «{{targetName}}»{{labelSuffix}}',
    icon: '🔗',
    category: 'share',
    chatPost: false,
  },
  'share.link_revoked': {
    template: '{{actorName}} отозвал(а) гостевую ссылку на «{{targetName}}»{{labelSuffix}}',
    icon: '⛔',
    category: 'share',
    chatPost: false,
  },
  // Смена адреса — тоже изменение доступа наружу: у части получателей он в этот момент
  // пропадает, поэтому событие стоит рядом с выдачей и отзывом, а не прячется в правку.
  'share.link_rotated': {
    template: '{{actorName}} сменил(а) адрес гостевой ссылки на «{{targetName}}»{{labelSuffix}}',
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
    template: '{{actorName}} опубликовал(а) маршрут «{{processName}}» вопреки предупреждениям: {{ruleList}}',
    icon: '⚠️',
    category: 'processes',
    chatPost: false,
  },

  // ---- КЭДО (modules/hr; refType='hr_member', refId=`<wsId>:<userId>` —
  // хроника вкладки «Хроника» на странице человека; workspaceId у записи
  // заполнен, поэтому она же видна в «Журнале организации» фильтром «Кадры») ----
  'hr.employment_updated': {
    template: '{{actorName}} изменил(а) трудовую карточку: {{fieldLabel}} {{from}} → {{to}}',
    icon: '📇',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_created': {
    template: '{{actorName}} начал(а) действие «{{kindLabel}}»{{documentSuffix}}',
    icon: '🧾',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_applied': {
    template: '{{kindLabel}}: применено{{documentSuffix}}',
    icon: '✅',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_failed': {
    template: '{{kindLabel}}: не применено — {{reason}}',
    icon: '⚠️',
    category: 'hr',
    chatPost: false,
  },
  'hr.action_cancelled': {
    template: '{{actorName}} отменил(а) действие «{{kindLabel}}»{{noteSuffix}}',
    icon: '🚫',
    category: 'hr',
    chatPost: false,
  },
  'hr.delivery_fixed': {
    template: '{{actorName}} зафиксировал(а) вручение: {{methodLabel}}{{trackSuffix}}',
    icon: '📬',
    category: 'hr',
    chatPost: false,
  },
  // Акт РАБОТОДАТЕЛЯ на кадровом документе подписан ЭЦП физлица (в сертификате
  // нет БИН юрлица) — предупреждение, не отказ (v1; жёсткость — после юриста).
  // Свой ключ, а не hr.action_failed: «не применено» рядом с настоящими
  // отказами применения вводило бы в заблуждение — действие как раз применилось.
  'hr.sign_bin_warning': {
    template: 'Предупреждение о подписи: {{reason}}',
    icon: '🖋️',
    category: 'hr',
    chatPost: false,
  },
  'hr.esutd_submitted': {
    template: '{{actorName}} отметил(а) сдачу в ЕСУТД: {{kindLabel}}{{numberSuffix}}',
    icon: '🏛️',
    category: 'hr',
    chatPost: false,
  },
  'hr.campaign_started': {
    template: '{{actorName}} запустил(а) ознакомление «{{title}}» ({{total}} адресатов)',
    icon: '📢',
    category: 'hr',
    chatPost: false,
  },
  'hr.campaign_acknowledged': {
    template: '{{targetName}} ознакомился(лась): «{{title}}»',
    icon: '👁️',
    category: 'hr',
    chatPost: false,
  },
  'hr.library_installed': {
    template: '{{actorName}} установил(а) из библиотеки «{{title}}»',
    icon: '📚',
    category: 'hr',
    chatPost: false,
  },
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

/**
 * Единый рендер текста записи хроники ({{placeholder}}, как у уведомлений).
 * Используется и API-синком (текст плашки в чат), и вебом (журнал) — одна строка везде.
 * Отсутствующие ключи → пустая строка (клиент не видит голый {{...}}).
 */
export function renderChatterText(
  typeKey: string,
  entry: {
    actorName?: string | null;
    changes?: ReadonlyArray<{ from: string | null; to: string | null }> | null;
    payload?: Record<string, unknown> | null;
  },
): string {
  const meta = (CHATTER_REGISTRY as Record<string, ChatterTypeMeta>)[typeKey];
  if (!meta) return typeKey;
  const first = entry.changes?.[0];
  // payload — снизу; from/to/actorName — сверху: авторитетные значения из changes
  // и снапшот актёра НЕ перекрываются одноимённым ключом payload.
  const vars: Record<string, unknown> = {
    ...(entry.payload ?? {}),
    from: first?.from ?? '—',
    to: first?.to ?? '—',
    actorName: entry.actorName?.trim() || 'Кто-то',
  };
  // Условная презентация — в рендере (не запечена в payload): филиал показываем,
  // только если он есть; формат можно менять без миграции вечных записей.
  if (vars.branchClause === undefined) {
    const branchName = entry.payload?.branchName;
    vars.branchClause = typeof branchName === 'string' && branchName
      ? ` · филиал «${branchName}»`
      : '';
  }
  return interpolateTemplate(meta.template, vars);
}
