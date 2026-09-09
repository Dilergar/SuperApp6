import { Injectable, OnModuleInit } from '@nestjs/common';
import { listCounterpartiesSchema } from '@superapp/shared';
import { I18nService } from '../../shared/i18n/i18n.service';
import { DatabaseService } from '../../shared/database/database.service';
import { NoteTargetRegistry } from '../notes/notes-targets.registry';
import { CounterpartiesService } from './counterparties.service';

/** Контрагент как цель привязки заметки («заметка о клиенте» — ядро Salesforce Notes) */
@Injectable()
export class CounterpartiesNotesTargetProvider implements OnModuleInit {
  constructor(
    private readonly registry: NoteTargetRegistry,
    private readonly db: DatabaseService,
    private readonly counterparties: CounterpartiesService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    this.registry.register('counterparty', {
      canView: async (viewerId, id) => !!(await this.load(viewerId, id)),
      describe: async (viewerId, id) => {
        const cp = await this.load(viewerId, id);
        return cp ? { title: cp.name, url: `/workspaces/${cp.workspaceId}/counterparties?open=${cp.id}`, workspaceId: cp.workspaceId } : null;
      },
      search: async (viewerId, ctx, q, limit) => {
        if (!ctx.workspaceId) return [];
        const page = await this.counterparties.list(viewerId, ctx.workspaceId, listCounterpartiesSchema.parse({ search: q || undefined, limit }));
        return page.items.map((c) => ({
          targetType: 'counterparty' as const,
          id: c.id,
          title: c.name,
          subtitle: c.bin ? `${this.i18n.translate('counterparties.idLabel.either')} ${c.bin}` : c.legalName ?? null,
        }));
      },
    });
  }

  private async load(viewerId: string, id: string) {
    const row = await this.db.counterparty.findUnique({ where: { id }, select: { id: true, workspaceId: true } });
    if (!row) return null;
    try {
      return await this.counterparties.get(viewerId, row.workspaceId, row.id);
    } catch {
      return null;
    }
  }
}
