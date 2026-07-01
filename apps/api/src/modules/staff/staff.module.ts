import { Module } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';

/**
 * StaffModule — сервис «Сотрудники» (B2B): справочники Должность/Отдел/Филиал +
 * назначения должностей со статусом обучения (фундамент Додзё/Трекера/Ленты).
 * Database/Roles/EventBus/AccessProjection приходят из @Global-модулей.
 * Экспортируется для WorkspacesService (каскад при увольнении, ростер, accept-найм).
 */
@Module({
  controllers: [StaffController],
  // Строковый токен для нод «Процессов» (ctx.deps.getService), как 'MessengerService'.
  providers: [StaffService, { provide: 'StaffService', useExisting: StaffService }],
  exports: [StaffService, 'StaffService'],
})
export class StaffModule {}
