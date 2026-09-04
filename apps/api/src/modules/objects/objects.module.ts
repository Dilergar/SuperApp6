import { Module } from '@nestjs/common';
import { ObjectsService } from './objects.service';
import { ObjectsController } from './objects.controller';
import { ObjectsRegistriesProvider } from './objects-registries.provider';
import { StaffingService } from './staffing.service';
import { StaffingController } from './staffing.controller';
import { ShiftsService } from './shifts.service';
import { ShiftsController } from './shifts.controller';
import { AttendanceService } from './attendance.service';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';
import { ObjectsJobs } from './objects.jobs';
import { ObjectsCalendarProvider } from './objects-calendar.provider';
import { ObjectsCardsProvider } from './objects-cards.provider';
import { DI_TOKENS } from '../../shared/di-tokens';
import { StaffModule } from '../staff/staff.module';
import { DriveModule } from '../drive/drive.module';
import { HrModule } from '../hr/hr.module';
import { CalendarModule } from '../calendar/calendar.module';

/**
 * ObjectsModule — сервис «Объекты»: дерево физических площадок организации
 * (площадка → здание → этаж → зона), юрлицо на объект, часовой пояс и правила смен.
 *
 * Хаб для других сервисов: штатное расписание, график смен и оборудование живут
 * вокруг объекта, а будущие Финансы и пропускная система ходят через порты этого
 * модуля. Движки (access/chatter/files/search/rich-cards) приходят из @Global —
 * регистрации в них собраны в ObjectsRegistriesProvider.
 */
@Module({
  imports: [StaffModule, DriveModule, HrModule, CalendarModule],
  controllers: [ObjectsController, StaffingController, ShiftsController, AssetsController],
  providers: [
    ObjectsService,
    StaffingService,
    ShiftsService,
    AttendanceService,
    AssetsService,
    ObjectsJobs,
    ObjectsRegistriesProvider,
    ObjectsCalendarProvider,
    ObjectsCardsProvider,
    // Порты-алиасы: чужие сервисы берут их через ModuleRef по строковому токену
    // (манифест shared/di-tokens.ts; смоук на бутстрапе валит старт, если пропали).
    { provide: DI_TOKENS.ObjectsPayrollPort, useExisting: StaffingService },
    { provide: DI_TOKENS.AttendancePort, useExisting: AttendanceService },
  ],
  exports: [
    ObjectsService,
    StaffingService,
    ShiftsService,
    AttendanceService,
    AssetsService,
    DI_TOKENS.ObjectsPayrollPort,
    DI_TOKENS.AttendancePort,
  ],
})
export class ObjectsModule {}
