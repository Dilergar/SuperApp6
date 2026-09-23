import { Injectable } from '@nestjs/common';
import { ENTITLEMENT_REGISTRY, type OrgSecurityOverviewDto } from '@superapp/shared';
import { forbidden } from '../../shared/errors/api-error';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { RolesService } from '../roles/roles.service';

const WS_CONTEXT = 'workspace';
const RETENTION_DEFAULT = ENTITLEMENT_REGISTRY['audit.retentionDays'].defaultFree as number;

/**
 * Доступ организации к своему журналу: право (owner/admin по `user_roles` — движок не
 * импортирует модуль организаций) и тариф (окно, выгрузка, стрим). Одна дверь для
 * контроллера, выгрузки и панели Кабинета — окно не может разойтись между ними.
 */
@Injectable()
export class AuditWorkspaceAccess {
  constructor(
    private readonly roles: RolesService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async assertManager(userId: string, workspaceId: string): Promise<'owner' | 'admin'> {
    const names = (await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId)).map((r) => r.role);
    if (names.includes('owner')) return 'owner';
    if (names.includes('admin')) return 'admin';
    // Не член — тот же ответ, что у организаций: существование чужой организации не раскрываем
    throw forbidden(names.length ? 'workspace.manageForbidden' : 'workspace.noAccess');
  }

  /** Окно журнала по тарифу (дни). Сбой резолва — бесплатное окно (fail-closed: меньше, не больше). */
  async retentionDays(workspaceId: string): Promise<number> {
    const v = await this.entitlements.valueOf({ type: 'workspace', id: workspaceId }, 'audit.retentionDays').catch(() => RETENTION_DEFAULT);
    // null у config-ключа = «без ограничения» оверрайдом — потолок хранения в БД (3 года)
    return typeof v === 'number' && v > 0 ? Math.min(v, 3 * 366) : v === null ? 3 * 366 : RETENTION_DEFAULT;
  }

  async overview(workspaceId: string): Promise<OrgSecurityOverviewDto> {
    const subject = { type: 'workspace' as const, id: workspaceId };
    const [retentionDays, canExport, canStream] = await Promise.all([
      this.retentionDays(workspaceId),
      this.entitlements.valueOf(subject, 'audit.export').then((v) => v === true, () => false),
      this.entitlements.valueOf(subject, 'audit.stream').then((v) => v === true, () => false),
    ]);
    return { retentionDays, canExport, canStream };
  }
}
