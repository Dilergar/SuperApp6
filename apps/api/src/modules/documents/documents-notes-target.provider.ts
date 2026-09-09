import { Injectable, OnModuleInit } from '@nestjs/common';
import { listOrgDocumentsSchema } from '@superapp/shared';
import { NoteTargetRegistry } from '../notes/notes-targets.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
import { DocumentsService } from './documents.service';

/** Карточка документа как цель привязки заметки; право решает DocumentsService.get */
@Injectable()
export class DocumentsNotesTargetProvider implements OnModuleInit {
  constructor(
    private readonly registry: NoteTargetRegistry,
    private readonly documents: DocumentsService,
    private readonly i18n: I18nService,
  ) {}

  /** «№» — знак русской типографики: номер приклеивается словом каталога */
  private number(value: string): string {
    return this.i18n.translate('documents.numberLabel', { number: value });
  }

  onModuleInit(): void {
    this.registry.register('document', {
      canView: async (viewerId, id) => {
        try {
          await this.documents.get(viewerId, id);
          return true;
        } catch {
          return false;
        }
      },
      describe: async (viewerId, id) => {
        try {
          const d = await this.documents.get(viewerId, id);
          return {
            title: d.number ? `${d.title} · ${this.number(d.number)}` : d.title,
            url: `/workspaces/${d.workspaceId}/documents/${d.id}`,
            workspaceId: d.workspaceId,
          };
        } catch {
          return null;
        }
      },
      search: async (viewerId, ctx, q, limit) => {
        if (!ctx.workspaceId) return [];
        try {
          const page = await this.documents.list(viewerId, ctx.workspaceId, listOrgDocumentsSchema.parse({ search: q || undefined, limit }));
          return page.items.slice(0, limit).map((d) => ({
            targetType: 'document' as const,
            id: d.id,
            title: d.title,
            subtitle: d.number ? this.number(d.number) : null,
          }));
        } catch {
          return [];
        }
      },
    });
  }
}
