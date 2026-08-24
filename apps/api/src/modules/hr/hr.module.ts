import { Module } from '@nestjs/common';
import { DI_TOKENS } from '../../shared/di-tokens';
import { StaffModule } from '../staff/staff.module';
import { DocumentsModule } from '../documents/documents.module';
import { ProcessesModule } from '../processes/processes.module';
import { TasksModule } from '../tasks/tasks.module';
import { HrService } from './hr.service';
import { HrActionsService } from './hr-actions.service';
import { HrCalendarService } from './hr-calendar.service';
import { HrLibraryService } from './hr-library.service';
import { HrExportService } from './hr-export.service';
import { MockEsutdDriver } from './hr-esutd.driver';
import { HrJobs } from './hr.jobs';
import { HrTemplateFieldsProvider } from './hr-template-fields.provider';
import { HrRegistriesProvider } from './hr-registries.provider';
import { HrController, HrPersonalController } from './hr.controller';

/**
 * КЭДО (шаг 5 документной вертикали) — тонкий модуль-связка: данные о трудовых
 * отношениях — домен «Сотрудников», бумаги о них — домен «Документооборота»,
 * hr их связывает и ничего не хранит дважды.
 *
 * Импортирует Staff (факт назначений), Documents (карточки приказов), Processes
 * (мастер библиотеки публикует маршруты) и Tasks (отзыв заявления при изданном
 * приказе ставит кадровику НАСТОЯЩУЮ задачу «издать приказ об отмене»).
 * ОБРАТНОЕ знание — только лениво: документы зовут порт `DI_TOKENS.HrService`
 * (машина действия, личный архив), ноды hr.* резолвят сервис тем же токеном.
 */
@Module({
  imports: [StaffModule, DocumentsModule, ProcessesModule, TasksModule],
  controllers: [HrController, HrPersonalController],
  providers: [
    HrCalendarService,
    HrActionsService,
    HrService,
    HrLibraryService,
    HrExportService,
    MockEsutdDriver,
    HrJobs,
    HrTemplateFieldsProvider,
    HrRegistriesProvider,
    { provide: DI_TOKENS.HrService, useExisting: HrService },
  ],
  exports: [HrService, DI_TOKENS.HrService],
})
export class HrModule {}
