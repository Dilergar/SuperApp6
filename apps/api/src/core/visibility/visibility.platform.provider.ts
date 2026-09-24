import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PlatformWorkspaceVisibilityPanelDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';

const DAYS_30 = 30 * 86_400_000;

/**
 * Кабинет платформы (D): панель `workspace.visibility` карточки 360 организации — версии
 * политик по типам, число правил, настройки, раскрытия и детекции массового раскрытия за 30
 * дней. Только агрегаты: какие поля и чьи — в журнале безопасности (консоль «Безопасность»).
 */
@Injectable()
export class VisibilityPlatformProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly panels: PlatformPanelRegistry,
  ) {}

  onModuleInit(): void {
    this.panels.register({
      key: 'workspace.visibility',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceVisibility',
      capability: 'platform.lookup.read',
      order: 66,
      eager: false,
      load: async (_actor, id): Promise<PlatformWorkspaceVisibilityPanelDto> => {
        const since = new Date(Date.now() - DAYS_30);
        const [rows, settings, reveals30d, massRevealDetections30d] = await Promise.all([
          this.db.visibilityPolicy.findMany({
            where: { ownerType: 'workspace', ownerId: id, status: { in: ['published', 'draft'] } },
            select: { recordType: true, version: true, status: true, publishedAt: true, _count: { select: { rules: true } } },
          }),
          this.db.workspaceVisibilitySettings.findUnique({ where: { workspaceId: id } }),
          this.db.securityEvent.count({ where: { workspaceId: id, eventKey: 'pii.reveal', occurredAt: { gte: since } } }),
          this.db.securityEvent.count({ where: { workspaceId: id, eventKey: 'detect.mass_reveal', occurredAt: { gte: since } } }),
        ]);
        const published = rows.filter((r) => r.status === 'published');
        const drafts = new Set(rows.filter((r) => r.status === 'draft').map((r) => r.recordType));
        return {
          policies: published.map((r) => ({ recordType: r.recordType, version: r.version, publishedAt: r.publishedAt?.toISOString() ?? null, ruleCount: r._count.rules, hasDraft: drafts.has(r.recordType) })),
          rulesTotal: rows.reduce((s, r) => s + r._count.rules, 0),
          settings: {
            notifyOnReveal: !!settings?.notifyOnReveal,
            dualControl: !!settings?.dualControl,
            allowDelegation: !!settings?.allowDelegation,
            updatedAt: settings?.updatedAt.toISOString() ?? null,
          },
          reveals30d,
          massRevealDetections30d,
        };
      },
    });
  }
}
