import { Module } from '@nestjs/common';
import { FinancesService } from './finances.service';
import { FinancesController } from './finances.controller';
import { FinancesCardsProvider } from './finances-cards.provider';
import { FinancesCron } from './finances.cron';
import { FinancesEvents } from './finances.events';

/**
 * «Финансы» (B2C): personal + family managerial accounting — an editable bookkeeping
 * book with a double-entry structure (Firefly III model) over accounts/categories,
 * strictly separate from the wallet's immutable coin ledger. Exports FinancesService
 * for the Processes "record operation" node (Phase 8 — org books).
 */
@Module({
  controllers: [FinancesController],
  providers: [
    FinancesService,
    // Строковый токен для нод «Процессов» (ctx.deps.getService), как 'MessengerService'.
    { provide: 'FinancesService', useExisting: FinancesService },
    FinancesCardsProvider,
    FinancesCron,
    FinancesEvents,
  ],
  exports: [FinancesService, 'FinancesService'],
})
export class FinancesModule {}
