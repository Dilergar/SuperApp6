import { QUICK_ACTION_SCOPES } from '../constants/quick-action';

export type QuickActionScope = (typeof QUICK_ACTION_SCOPES)[number];

/**
 * A registered quick action, as exposed to the chat UI menus (the ＋-menu and a message's
 * corner menu). Services register descriptors with the QuickActionRegistry; the web maps
 * `key` to a modal + an API call. Adding a new action later = one registration.
 */
export interface QuickActionDescriptor {
  /** Stable key the web maps to a modal/handler (e.g. 'task.create', 'message.schedule'). */
  key: string;
  /**
   * Подпись кнопки, УЖЕ переведённая сервером в языке запроса: реестр движка
   * хранит ключ каталога (`labelKey`), а слово подставляется при чтении —
   * иначе меню чата навсегда осталось бы на языке того, кто его писал.
   */
  label: string;
  /** Emoji/icon hint. */
  icon: string;
  /** Where it shows: composer ＋-menu and/or a message's corner menu. */
  scopes: QuickActionScope[];
  /** Optional short subtitle for the menu. */
  description?: string;
}
