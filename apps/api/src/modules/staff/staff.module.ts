import { Module } from '@nestjs/common';
import { DI_TOKENS } from '../../shared/di-tokens';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { StaffTemplateFieldsProvider } from './staff-template-fields.provider';
import { OrgGraphService } from './org-graph.service';
import { OrgRightsService } from './org-rights.service';
import { OrgService } from './org.service';
import { OrgController } from './org.controller';
import { StaffRegistriesProvider } from './staff-registries.provider';

/**
 * StaffModule — сервис «Сотрудники» (B2B): справочники Должность/Отдел/Объект +
 * назначения должностей со статусом обучения (фундамент Додзё/Трекера/Ленты) +
 * ОРГСТРУКТУРА (вертикаль власти на графе должностей и объектов: головы, подчинение,
 * заместители, областные права, канвас). Один агрегат — ноль новых рёбер модулей.
 * Database/Roles/EventBus/AccessProjection/Redis приходят из @Global-модулей.
 * Экспортируется для WorkspacesService (каскад при увольнении, ростер, accept-найм)
 * и для регистраций в core/audiences (относительные адресаты manager_of/…).
 */
@Module({
  controllers: [StaffController, OrgController],
  // Строковый токен для нод «Процессов» (ctx.deps.getService), как 'MessengerService'.
  providers: [
    StaffService,
    StaffTemplateFieldsProvider,
    OrgGraphService,
    OrgRightsService,
    OrgService,
    StaffRegistriesProvider,
    { provide: DI_TOKENS.StaffService, useExisting: StaffService },
  ],
  exports: [StaffService, OrgService, OrgGraphService, DI_TOKENS.StaffService],
})
export class StaffModule {}
