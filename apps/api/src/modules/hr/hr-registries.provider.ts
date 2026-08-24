import { Injectable, OnModuleInit } from '@nestjs/common';
import { PERSONAL_DOC_REF_TYPE, WORKSPACE_ROLE_RANK } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { HR_MEMBER_REF_TYPE } from './hr.constants';

/**
 * Регистрации КЭДО в @Global-движках (Принцип 1, паттерн counterparties).
 */
@Injectable()
export class HrRegistriesProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly chatterRegistry: ChatterRefRegistry,
  ) {}

  onModuleInit(): void {
    // ---- Личная запись-архив: файл жив, пока жива запись ----
    // Связь `personal_doc` — НАСТОЯЩЕЕ место файла: она и переживает purge
    // организации (реап сирот файл с живым местом не трогает). Видит — ТОЛЬКО
    // владелец записи: это его личный архив.
    this.filesRegistry.register(PERSONAL_DOC_REF_TYPE, {
      canView: async (viewerId, refId) => {
        const record = await this.db.personalDocRecord.findUnique({
          where: { id: refId },
          select: { userId: true },
        });
        return record?.userId === viewerId;
      },
      // Прикладывать к записи-архиву нечего и незачем — связь ставит система
      canAttach: async () => false,
      // Личный архив бессрочен: пока жива запись, файл не удаляется ничем
      blocksDeletion: async (refId) => {
        const count = await this.db.personalDocRecord.count({ where: { id: refId } });
        return count > 0;
      },
    });

    // ---- Хроника страницы человека (`hr_member`, refId = `<wsId>:<userId>`) ----
    // Видят Менеджер+ и сам человек — тот же гейт, что у трудовой карточки.
    this.chatterRegistry.register(HR_MEMBER_REF_TYPE, {
      canView: async (viewerId, refId) => {
        const [workspaceId, subjectUserId] = refId.split(':');
        if (!workspaceId || !subjectUserId) return false;
        if (viewerId === subjectUserId) {
          const own = await this.roles.getRolesInContext(viewerId, 'workspace', workspaceId);
          return own.some((r) => r.role !== 'contractor');
        }
        const roles = await this.roles.getRolesInContext(viewerId, 'workspace', workspaceId);
        const rank = Math.max(0, ...roles.map((r) => WORKSPACE_ROLE_RANK[r.role as keyof typeof WORKSPACE_ROLE_RANK] ?? 0));
        return rank >= WORKSPACE_ROLE_RANK.manager;
      },
    });
  }
}
