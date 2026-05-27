import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { CurrencyService } from './currency.service';
import { EscrowService } from './escrow.service';
import { WalletController } from './wallet.controller';

/**
 * Wallet: issued currencies, the immutable ledger and task escrow.
 * LedgerService = low-level money mechanics; CurrencyService = currency lifecycle + the
 * user-facing wallet; EscrowService = per-participant task-reward escrow. Exports Ledger &
 * Escrow so the Tasks module can compose them inside its own transactions.
 */
@Module({
  controllers: [WalletController],
  providers: [LedgerService, CurrencyService, EscrowService],
  exports: [LedgerService, EscrowService],
})
export class WalletModule {}
