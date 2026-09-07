import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_REGISTRY,
  notificationDef,
  notificationServicesForContext,
  notificationTypesForContext,
  type NotificationPolicyMode,
  type PutWorkspaceNotificationPolicyInput,
  type WorkspaceNotificationPolicyDto,
  type WorkspaceNotificationPolicyServiceDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../roles/roles.service';
import { badRequest, forbidden, notFound } from '../../shared/errors/api-error';

/**
 * Политика организации (v1): дефолты + замки по типу/сервису — Salesforce Notification
 * Delivery Settings + Courier REQUIRED. Личное сильнее дефолта, но не замка; замок только
 * на in-app/push (SMS запереть нельзя) и только на `lockable`-типах B2B-сервисов.
 * Гейт — «управление организацией»: admin / owner.
 */
@Injectable()
export class NotificationsPolicyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
  ) {}

  async get(userId: string, workspaceId: string): Promise<WorkspaceNotificationPolicyDto> {
    await this.assertManage(userId, workspaceId);
    const rows = await this.db.workspaceNotificationPolicy.findMany({
      where: { workspaceId },
      select: { subjectKind: true, subjectKey: true, channel: true, mode: true },
      orderBy: [{ subjectKind: 'asc' }, { subjectKey: 'asc' }],
    });
    return {
      workspaceId,
      rules: rows.map((r) => ({
        subjectKind: r.subjectKind as 'service' | 'type',
        subjectKey: r.subjectKey,
        channel: r.channel as 'inapp' | 'push',
        mode: r.mode as NotificationPolicyMode,
      })),
      services: this.shape(),
    };
  }

  /** PUT заменяет набор целиком (явная кнопка «Сохранить»). */
  async put(userId: string, workspaceId: string, input: PutWorkspaceNotificationPolicyInput): Promise<WorkspaceNotificationPolicyDto> {
    await this.assertManage(userId, workspaceId);
    const allowedServices = new Set(notificationServicesForContext(workspaceId));
    for (const rule of input.rules) {
      if (rule.subjectKind === 'type') {
        const def = notificationDef(rule.subjectKey);
        if (!def) throw badRequest('notification.unknownType');
        if (def.priority === 'critical') throw badRequest('notification.critical.immutable');
        if (def.contexts === 'personal' || !allowedServices.has(def.service)) throw badRequest('notification.unknownType');
        if (rule.mode === 'locked_on' && !def.lockable) throw badRequest('notification.policy.notLockable');
      } else {
        if (!allowedServices.has(rule.subjectKey as never)) throw badRequest('notification.unknownType');
        // Замок на сервис = замок на все его lockable-типы; если таких нет — замок бессмыслен
        if (rule.mode === 'locked_on') {
          const lockable = notificationTypesForContext(rule.subjectKey as never, workspaceId).some((t) => NOTIFICATION_REGISTRY[t].lockable);
          if (!lockable) throw badRequest('notification.policy.notLockable');
        }
      }
    }
    // Набор приходит целиком, и одна и та же тройка может прийти дважды (клиент собрал
    // правило и по сервису, и по типу; повтор из истории формы). Уникум в БД ответил бы
    // на это 500-й: схлопываем сами — побеждает последнее сказанное.
    const unique = new Map<string, PutWorkspaceNotificationPolicyInput['rules'][number]>();
    for (const r of input.rules) unique.set(`${r.subjectKind}:${r.subjectKey}:${r.channel}`, r);

    await this.db.$transaction(async (tx) => {
      await tx.workspaceNotificationPolicy.deleteMany({ where: { workspaceId } });
      if (unique.size) {
        await tx.workspaceNotificationPolicy.createMany({
          data: [...unique.values()].map((r) => ({
            workspaceId,
            subjectKind: r.subjectKind,
            subjectKey: r.subjectKey,
            channel: r.channel,
            mode: r.mode,
            updatedBy: userId,
          })),
        });
      }
    });
    return this.get(userId, workspaceId);
  }

  /** Форма матрицы: B2B-сервисы и их не-critical типы с флагом lockable. */
  private shape(): WorkspaceNotificationPolicyServiceDto[] {
    const out: WorkspaceNotificationPolicyServiceDto[] = [];
    for (const service of notificationServicesForContext('workspace-any')) {
      const types = notificationTypesForContext(service, 'workspace-any').filter((t) => NOTIFICATION_REGISTRY[t].priority !== 'critical');
      if (!types.length) continue;
      out.push({
        service,
        types: types.map((t) => ({
          type: t,
          priority: NOTIFICATION_REGISTRY[t].priority,
          icon: NOTIFICATION_REGISTRY[t].icon,
          lockable: !!NOTIFICATION_REGISTRY[t].lockable,
        })),
      });
    }
    return out;
  }

  private async assertManage(userId: string, workspaceId: string): Promise<void> {
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!ws) throw notFound('workspace.notFound');
    const roles = await this.roles.getRolesInContext(userId, 'workspace', workspaceId);
    if (!roles.some((r) => r.role === 'owner' || r.role === 'admin')) throw forbidden('notification.policy.noAccess');
  }
}
