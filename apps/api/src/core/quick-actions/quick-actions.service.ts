import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { QuickActionDescriptor, QuickActionScope } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
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
    if (!chat) throw new NotFoundException('Чат не найден');

    const ok = await this.access.can({ type: 'user', id: viewerId }, 'chat.view', chatId);
    if (!ok) throw new ForbiddenException('Нет доступа к чату');

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
      out.push({ key: a.key, label: a.label, icon: a.icon, scopes: a.scopes, description: a.description });
    }
    return out;
  }
}
