import { Module } from '@nestjs/common';
import { CounterpartiesService } from './counterparties.service';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesRegistriesProvider } from './counterparties-registries.provider';
import { CounterpartiesRichCardsProvider } from './counterparties-rich-cards.provider';

/**
 * Сервис «Контрагенты» (B2B) — единый справочник внешних сторон организации.
 *
 * Тонкий модуль + регистрации (Принцип 1): хроника, поиск и группа полей
 * «Контрагент» подключаются в @Global-движки провайдером. Экспортирует сервис
 * «Документообороту» (внешний контур) и будущим Счетам/Финансам B2B.
 */
@Module({
  controllers: [CounterpartiesController],
  providers: [CounterpartiesService, CounterpartiesRegistriesProvider, CounterpartiesRichCardsProvider],
  exports: [CounterpartiesService],
})
export class CounterpartiesModule {}
