import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { LifecycleExportRegistry, type LifecycleExportContext, type LifecycleExportPage } from '../lifecycle/lifecycle.export.registry';
import { AUDIT_EVENT_ENTITY } from './audit.constants';
import { ownAddress } from './audit.my-data.service';
import { AuditQueryService, AUDIT_ROW_SELECT, type AuditRow, type AuditViewer } from './audit.query.service';
import { AuditWorkspaceAccess } from './audit.workspace-access';

/**
 * Журнал безопасности в выгрузке данных (core/lifecycle Э6) — три зрителя, как в ленте:
 *  - человек: события его ленты (`visSubject`) за весь срок хранения — как «Мои данные»,
 *    полный IP только там, где адрес его собственный;
 *  - организация: её журнал (`visWorkspace`) в окне тарифа `audit.retentionDays` и только при
 *    фиче `audit.export` — архив не обходит тариф журнала; без фичи — пропуск с причиной.
 * Строки — форма ленты (текст в языке заказчика), keyset по id события.
 */
@Injectable()
export class AuditLifecycleExportProvider implements OnModuleInit {
  constructor(
    private readonly registry: LifecycleExportRegistry,
    private readonly db: DatabaseService,
    private readonly query: AuditQueryService,
    private readonly access: AuditWorkspaceAccess,
    private readonly envelope: KeysEnvelopeService,
  ) {}

  onModuleInit(): void {
    for (const side of ['user', 'workspace'] as const) {
      this.registry.register('SecurityEvent', side, {
        page: (ctx, cursor, limit) => this.page(ctx, cursor, limit),
        verify: (ctx, rows) => this.owned(ctx, rows.map((r) => String(r.eventId))),
        skip: async (ctx) => (ctx.side === 'workspace' && !(await this.access.overview(ctx.subjectId)).canExport ? 'entitlement' : null),
      });
    }
  }

  private async viewer(ctx: LifecycleExportContext): Promise<AuditViewer> {
    return ctx.side === 'user' ? { kind: 'subject', userId: ctx.subjectId } : { kind: 'workspace', workspaceId: ctx.subjectId, retentionDays: await this.access.retentionDays(ctx.subjectId) };
  }

  private async page(ctx: LifecycleExportContext, cursor: string | null, limit: number): Promise<LifecycleExportPage> {
    const viewer = await this.viewer(ctx);
    // Человеку — весь срок хранения (как «Мои данные»), организации — проекция её ленты (окно тарифа)
    const where: Prisma.SecurityEventWhereInput = ctx.side === 'user' ? { visSubject: true, subjectUserId: ctx.subjectId } : this.query.projection(viewer);
    const rows = await this.db.securityEvent.findMany({
      where: { ...where, ...(cursor && /^\d{1,19}$/.test(cursor) ? { id: { gt: BigInt(cursor) } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
      select: { ...AUDIT_ROW_SELECT, ipEnc: true },
    });
    const dtos = await this.query.toDtos(viewer, rows.map(({ ipEnc: _ip, ...r }) => r as AuditRow), ctx.locale);
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      let ip: string | null = null;
      if (ctx.side === 'user' && row.ipEnc && ownAddress(ctx.subjectId, row)) {
        const r = await this.envelope.tryDecrypt({ type: 'platform' }, { entity: AUDIT_EVENT_ENTITY, field: 'ip', ownerType: 'platform', ownerId: 'platform' }, row.ipEnc);
        ip = r.ok ? r.value : null;
      }
      out.push({ ...dtos[i]!, ...(ctx.side === 'user' ? { ip } : {}) });
    }
    const last = rows[rows.length - 1];
    return { rows: out, next: rows.length === limit && last ? last.id.toString() : null };
  }

  /** Перепроверка: каждое событие страницы видно этому зрителю (флаг видимости и владелец). */
  private async owned(ctx: LifecycleExportContext, eventIds: readonly string[]): Promise<boolean> {
    if (!eventIds.length) return true;
    const rows = await this.db.securityEvent.findMany({ where: { eventId: { in: [...eventIds] } }, select: { visSubject: true, visWorkspace: true, subjectUserId: true, workspaceId: true } });
    // «Чужого нет»: событие, ушедшее со сброшенной по сроку партицией между страницей и
    // проверкой, не чужое (ночной сброс не должен ронять идущую выгрузку)
    return rows.every((r) => (ctx.side === 'user' ? r.visSubject && r.subjectUserId === ctx.subjectId : r.visWorkspace && r.workspaceId === ctx.subjectId));
  }
}
