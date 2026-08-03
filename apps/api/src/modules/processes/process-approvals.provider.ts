import { Injectable, OnModuleInit } from '@nestjs/common';
import { TEAM_WORKSPACE_ROLES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ApprovalsRegistry } from '../../core/approvals/approvals.registry';
import { ProcessEngineService } from './process-engine.service';
import { PROCESS_INSTANCE_REF_TYPE, PROCESS_ORIGIN_TYPE } from './process-builtin-nodes';

/**
 * Подключение Процессов к движку согласований — обе стороны реестром, ни одного
 * импорта Процессов внутрь движка (то же направление, что у записи звонков).
 *
 *  - как ПРЕДМЕТ: запуск процесса, когда маршрут ведёт не документ, а сам процесс;
 *  - как ВЕДУЩИЙ: заявка закрылась → движок зовёт хук → токен идёт дальше.
 */
@Injectable()
export class ProcessApprovalsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsRegistry,
    private readonly engine: ProcessEngineService,
  ) {}

  onModuleInit(): void {
    this.approvals.register(PROCESS_INSTANCE_REF_TYPE, {
      // Заводить заявку на запуск процесса вправе тот, кто этот запуск вообще видит:
      // сама нода зовёт движок от имени инициатора. Проверка живёт здесь, потому что
      // через describeForCreate проходит ЛЮБОЕ заведение заявки.
      describeForCreate: async (userId, instanceId) => {
        const instance = await this.db.processInstance.findUnique({
          where: { id: instanceId },
          select: { workspaceId: true, definition: { select: { name: true } } },
        });
        if (!instance) return null;
        if (!(await this.isTeamMember(userId, instance.workspaceId))) return null;
        return { title: instance.definition.name, icon: 'processes', workspaceId: instance.workspaceId };
      },

      describeRef: async (instanceId) => {
        const instance = await this.db.processInstance.findUnique({
          where: { id: instanceId },
          select: { workspaceId: true, definition: { select: { name: true } } },
        });
        if (!instance) return null;
        return {
          title: instance.definition.name,
          icon: 'processes',
          href: `/workspaces/${instance.workspaceId}/processes/instances/${instanceId}`,
        };
      },

      /**
       * Кто может ВИДЕТЬ заявку, не будучи её адресатом или автором: любой член
       * команды этой организации. Планка та же, что у чтения запусков процессов —
       * иначе согласующий видел бы решение, а его руководитель нет.
       */
      canView: async (userId, instanceId) => {
        const instance = await this.db.processInstance.findUnique({
          where: { id: instanceId },
          select: { workspaceId: true },
        });
        if (!instance) return false;
        return this.isTeamMember(userId, instance.workspaceId);
      },
    });

    this.approvals.registerOrigin(PROCESS_ORIGIN_TYPE, {
      onResolved: async (originRef, outcome) => {
        // `originRef` собран нодой как «инстанс:шаг» — для движка это непрозрачная
        // строка, разбирать её имеет право только эта сторона.
        const sep = originRef.indexOf(':');
        if (sep <= 0) return;
        await this.engine.resumeApproval(originRef.slice(0, sep), originRef.slice(sep + 1), outcome);
      },
    });
  }

  /** Действующий член команды организации (Подрядчик — не команда) */
  private async isTeamMember(userId: string, workspaceId: string): Promise<boolean> {
    const member = await this.db.userRole.count({
      where: {
        userId,
        context: 'workspace',
        tenantId: workspaceId,
        isActive: true,
        role: { in: [...TEAM_WORKSPACE_ROLES] },
      },
    });
    return member > 0;
  }
}
