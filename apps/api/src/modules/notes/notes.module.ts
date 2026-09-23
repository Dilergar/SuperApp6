import { Module } from '@nestjs/common';
import { RolesModule } from '../../core/roles/roles.module';
import { DriveModule } from '../drive/drive.module';
import { MessengerModule } from '../messenger/messenger.module';
import { NotesAccessService } from './notes-access.service';
import { NotesBoardService } from './notes-board.service';
import { NotesController } from './notes.controller';
import { NotesCron } from './notes.cron';
import { NotesFoldersService } from './notes-folders.service';
import { NotesJobs } from './notes.jobs';
import { NotesLinksService } from './notes-links.service';
import { NotesRegistriesProvider } from './notes-registries.provider';
import { NotesRichCardsProvider } from './notes-rich-cards.provider';
import { NotesSearchService } from './notes-search.service';
import { NotesShareService } from './notes-share.service';
import { NoteTargetRegistry } from './notes-targets.registry';
import { NotesService } from './notes.service';
import { NotesNotificationRefsProvider } from './notes-notification-refs.provider';
import { NotesWorkspacePurgeProvider } from './notes-workspace-purge.provider';

/**
 * Сервис «Заметки» — B2C и B2B в одном модуле (пространство личное или организации).
 *
 * Files / Access / Jobs / Chatter / Notifications / Contacts / Search / RichCards /
 * QuickActions объявлены @Global; явно импортируются RolesModule (роли организации
 * для надзора владельца/админов), DriveModule (маршрут картинок на Диск) и
 * MessengerModule (Mentions Hub — лента упоминаний общая с чатом).
 *
 * NoteTargetRegistry экспортируется наружу: Задачи, Контрагенты, Объекты и Документы
 * регистрируют в нём свои сущности как цели привязки (направление импорта перевёрнуто).
 */
@Module({
  imports: [RolesModule, DriveModule, MessengerModule],
  controllers: [NotesController],
  providers: [
    // Движок уведомлений: резолвер объекта (право видеть батчем + deep link) — фича → движок
    NotesNotificationRefsProvider,
    NoteTargetRegistry,
    NotesAccessService,
    NotesFoldersService,
    NotesLinksService,
    NotesSearchService,
    NotesService,
    NotesShareService,
    NotesBoardService,
    NotesRichCardsProvider,
    NotesRegistriesProvider,
    NotesJobs,
    NotesCron,
    // Каскад окончательного удаления организации: её пространство заметок уходит с ней
    NotesWorkspacePurgeProvider,
  ],
  exports: [NoteTargetRegistry, NotesService],
})
export class NotesModule {}
