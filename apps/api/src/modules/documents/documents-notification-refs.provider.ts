import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { workspaceMembersOf } from '../../core/notifications/notifications.ref-helpers';

/** Документ организации и кампания ознакомления: видят члены организации; рич-карта `org_document`. */
@Injectable()
export class DocumentsNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('org_document', {
      canViewMany: async (userIds, documentId) => {
        const doc = await this.db.orgDocument.findUnique({ where: { id: documentId }, select: { workspaceId: true } });
        if (!doc) return [];
        return workspaceMembersOf(this.db, doc.workspaceId, userIds);
      },
      href: (ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/documents/${ref.id}` : null),
      richCardType: 'org_document',
    });
    this.refs.register('doc_campaign', {
      canViewMany: async (userIds, campaignId) => {
        const c = await this.db.docCampaign.findUnique({ where: { id: campaignId }, select: { workspaceId: true } });
        if (!c) return [];
        return workspaceMembersOf(this.db, c.workspaceId, userIds);
      },
      href: (_ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/documents?tab=campaigns` : null),
    });
  }
}
