import { Module } from '@nestjs/common';
import { CounterpartiesService } from './counterparties.service';
import { CounterpartiesNotesTargetProvider } from './counterparties-notes-target.provider';
import { NotesModule } from '../notes/notes.module';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesRegistriesProvider } from './counterparties-registries.provider';
import { CounterpartiesRichCardsProvider } from './counterparties-rich-cards.provider';
import { CounterpartiesVisibilityProvider } from './counterparties-visibility.provider';

/**
 * Сервис «Контрагенты» (B2B) — единый справочник внешних сторон организации.
 *
 * Тонкий модуль + регистрации (Принцип 1): хроника, поиск и группа полей
 * «Контрагент» подключаются в @Global-движки провайдером. Экспортирует сервис
 * «Документообороту» (внешний контур) и будущим Счетам/Финансам B2B.
 */
@Module({
  imports: [NotesModule],
  controllers: [CounterpartiesController],
  providers: [
    CounterpartiesService,
    CounterpartiesNotesTargetProvider,
    CounterpartiesRegistriesProvider,
    CounterpartiesRichCardsProvider,
    CounterpartiesVisibilityProvider,
  ],
  exports: [CounterpartiesService],
})
export class CounterpartiesModule {}
