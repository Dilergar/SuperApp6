import { Module } from '@nestjs/common';
import { MessengerModule } from '../messenger/messenger.module';
import { OfficeService } from './office.service';
import { OfficeController } from './office.controller';
import { OfficeCron } from './office.cron';
import { OfficeRichCardsProvider } from './office-rich-cards.provider';

/**
 * OfficeModule — сервис «Виртуальный офис» (B2B): видеовстречи организации на движке
 * core/calls (v1 — аналог Google Meet; Discord-комнаты — фаза 2). Синхронные рёбра:
 * MessengerService (чат встречи — импорт модуля), CallsService/CallsRefRegistry и
 * NotificationsService/Roles/AccessProjection — из @Global-модулей.
 */
@Module({
  imports: [MessengerModule],
  controllers: [OfficeController],
  providers: [
    OfficeService,
    OfficeCron,
    OfficeRichCardsProvider,
    // Строковый токен для ленивого ModuleRef-резолва из WorkspacesService (каскад
    // увольнения снимает участия во встречах) — избегаем цикла модулей, паттерн проекта.
    { provide: 'OfficeService', useExisting: OfficeService },
  ],
  exports: [OfficeService, 'OfficeService'],
})
export class OfficeModule {}
