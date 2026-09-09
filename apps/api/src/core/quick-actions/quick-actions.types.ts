import type { QuickActionDescriptor } from '@superapp/shared';

/** The chat context handed to an action's availability gate. */
export interface QuickActionContext {
  viewerId: string;
  chatId: string;
  chatType: string;
  parentType: string | null;
  workspaceId: string | null;
}

/**
 * A registered quick action = what the menu MEANS + an optional availability gate. Feature
 * services register these on module init; the engine stays domain-agnostic (no core→feature
 * import), same as core/rich-cards & core/search.
 *
 * Реестр хранит КЛЮЧ каталога, а не готовую строку: слово подставляется при
 * ЧТЕНИИ в языке запроса (`QuickActionsService`). Строка в реестре = один язык
 * навсегда и сразу у всех клиентов.
 */
export interface QuickActionRegistration
  extends Omit<QuickActionDescriptor, 'label' | 'description'> {
  /** Ключ каталога подписи кнопки (`tasks.quickAction.label`). */
  labelKey: string;
  /** Ключ каталога подстрочника меню. */
  descriptionKey?: string;
  /** Optional gate (chat context / capability). Omitted → available in any chat the viewer can post to. */
  isAvailable?: (ctx: QuickActionContext) => boolean | Promise<boolean>;
}
