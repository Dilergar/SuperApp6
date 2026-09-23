import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { AUDIT_EXPORT_REF } from '../../core/audit/audit.constants';
import { DriveRoutingRegistry } from './drive-routing.registry';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Маршруты Диска для файлов ДВИЖКОВ платформы. Движок (core/*) не импортирует модули и
 * сам в реестр Диска не встанет — регистрирует модуль Диска (направление «модуль → движок»).
 *  - `audit_export` (core/audit): выгрузка журнала безопасности организации → её Диск,
 *    закрытая системная папка «Безопасность» (видят владелец и админы).
 */
@Injectable()
export class DriveCoreRoutesProvider implements OnModuleInit {
  constructor(
    private readonly routing: DriveRoutingRegistry,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.routing.register(AUDIT_EXPORT_REF, {
      resolvePlacement: async (workspaceId) => {
        if (!UUID_RE.test(workspaceId)) return null;
        const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
        return ws ? { ownerType: 'workspace', ownerId: ws.id, folder: 'security_exports' } : null;
      },
    });
  }
}
