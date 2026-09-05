import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NoteTargetRegistry } from '../notes/notes-targets.registry';
import { ObjectsService } from './objects.service';

/** Объект (площадка/здание/этаж) как цель привязки заметки; право — capsFor через предков */
@Injectable()
export class ObjectsNotesTargetProvider implements OnModuleInit {
  constructor(
    private readonly registry: NoteTargetRegistry,
    private readonly db: DatabaseService,
    private readonly objects: ObjectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('branch', {
      canView: async (viewerId, id) => !!(await this.visible(viewerId, id)),
      describe: async (viewerId, id) => {
        const b = await this.visible(viewerId, id);
        return b ? { title: b.name, url: `/workspaces/${b.workspaceId}/objects/${b.id}`, workspaceId: b.workspaceId } : null;
      },
      search: async (viewerId, ctx, q, limit) => {
        if (!ctx.workspaceId) return [];
        let tree;
        try {
          tree = await this.objects.tree(viewerId, ctx.workspaceId, false);
        } catch {
          return [];
        }
        const needle = q.toLowerCase();
        return tree.nodes
          .filter((n) => !needle || n.name.toLowerCase().includes(needle))
          .slice(0, limit)
          .map((n) => ({ targetType: 'branch' as const, id: n.id, title: n.name, subtitle: n.kind ? String(n.kind) : null }));
      },
    });
  }

  private async visible(viewerId: string, id: string) {
    const branch = await this.db.staffBranch.findUnique({
      where: { id },
      select: { id: true, name: true, workspaceId: true, ancestorIds: true, archivedAt: true },
    });
    if (!branch) return null;
    try {
      const scope = await this.objects.scopeOf(viewerId, branch.workspaceId);
      return this.objects.capsFor(scope, branch).view ? branch : null;
    } catch {
      return null;
    }
  }
}
