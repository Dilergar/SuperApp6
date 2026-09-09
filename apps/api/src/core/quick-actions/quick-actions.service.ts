import { Injectable } from '@nestjs/common';
import { forbidden, notFound } from '../../shared/errors/api-error';
import type { QuickActionDescriptor, QuickActionScope } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { AccessService } from '../access/access.service';
import { QuickActionRegistry } from './quick-actions.registry';

/**
 * Resolves the quick actions available to a viewer in a given chat + scope. Verifies the
 * viewer can view the chat (engine), loads the chat context (type/parent), then filters the
 * registered actions by scope + each action's optional availability gate.
 */
@Injectable()
export class QuickActionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly registry: QuickActionRegistry,
    private readonly i18n: I18nService,
  ) {}

  async listForChat(
    viewerId: string,
    chatId: string,
    scope: QuickActionScope,
  ): Promise<QuickActionDescriptor[]> {
    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: { id: true, type: true, parentType: true, workspaceId: true },
    });
    if (!chat) throw notFound('chat.notFound');

    const ok = await this.access.can({ type: 'user', id: viewerId }, 'chat.view', chatId);
    if (!ok) throw forbidden('chat.noAccess');

    const ctx = {
      viewerId,
      chatId,
      chatType: chat.type,
      parentType: chat.parentType,
      workspaceId: chat.workspaceId,
    };

    const out: QuickActionDescriptor[] = [];
    for (const a of this.registry.all()) {
      if (!a.scopes.includes(scope)) continue;
      if (a.isAvailable && !(await a.isAvailable(ctx))) continue;
      // Слово — при ЧТЕНИИ, в языке запроса: реестр знает только ключ.
      out.push({
        key: a.key,
        label: this.i18n.translate(a.labelKey),
        icon: a.icon,
        scopes: a.scopes,
        description: a.descriptionKey ? this.i18n.translate(a.descriptionKey) : undefined,
      });
    }
    return out;
  }
}
