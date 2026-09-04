// Rich Cards — interactive service-posted cards in the messenger (Phase 3).
// A reusable, cross-service registry (core/rich-cards on the backend): a service
// posts a card of a known type referencing one of its entities; buttons carry an
// ACTION KEY that a central endpoint routes to a server handler (which re-checks
// permissions). Modeled on Slack Block Kit (action_id) + MS Adaptive Cards (Action.Execute).

// What entity a card points at. The renderer fetches LIVE data by (refType, refId),
// so a card always reflects current state.
// fin_transaction / fin_month — Финансы: SNAPSHOT cards (the stored share-time payload is
// the message body; live re-render is only for viewers with finbook access). fin_month's
// refId is composite: `<bookId>:<YYYY-MM>`.
// office_room — встреча «Виртуального офиса»: кнопка «Присоединиться» = href, без action-ключей.
// drive_node — папка или файл Диска: карточка со ссылкой «Открыть», БЕЗ action-ключей.
// Действий у неё нет намеренно: у типов Диска пустой фанаут эпох кэша (права считает
// собственный предикат по живым tuples), и перепроверка способности через can() на
// execute показывала бы устаревший ответ до десяти минут.
// counterparty — карточка справочника «Контрагенты»: название, БИН/ИИН, подписант,
// ссылка «Открыть». БЕЗ action-ключей (тот же довод, что у drive_node/org_document:
// права считает предикат сервиса по роли, а не can() движка).
export const RICH_CARD_REF_TYPES = ['order', 'listing', 'crowdfunding', 'task', 'event', 'fin_transaction', 'fin_month', 'office_room', 'drive_node', 'approval_request', 'org_document', 'counterparty', 'branch', 'shift'] as const;

// Button visual styles.
export const RICH_CARD_ACTION_STYLES = ['primary', 'danger', 'default'] as const;

// The STABLE vocabulary of card actions. Each maps (server-side, in core/rich-cards)
// to a handler + a required capability that is re-checked before执行. Clients never
// call service APIs directly — they POST an action key here.
export const RICH_CARD_ACTION_KEYS = [
  // shop — order
  'order.confirm',
  'order.reject',
  'order.cancel',
  'order.refund',
  // shop — listing / crowdfunding
  'listing.buy',
  'listing.talk', // open buyer↔seller DM (no state change)
  'crowdfunding.contribute',
  'crowdfunding.withdraw',
  // tasks
  'task.accept',
  'task.return',
  'task.take',
  // calendar
  'event.rsvp_accept',
  'event.rsvp_decline',
  'event.rsvp_tentative',
  // core/approvals — решение прямо из чата. Отклонение и возврат требуют причины,
  // поэтому их кнопки открывают поле ввода, а не срабатывают одним нажатием.
  'approval.approve',
  'approval.reject',
  'approval.return',
  // Объекты: открытую смену берут прямо из чата объекта («кто возьмёт субботу?»)
  'shift.take',
] as const;

export const RICH_CARD_LIMITS = {
  maxFields: 12,
  maxActions: 6,
} as const;
