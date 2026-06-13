import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { CurrencyService } from './currency.service';
import { EscrowService } from './escrow.service';
import { WalletController } from './wallet.controller';
import { WalletCron } from './wallet.cron';

/**
 * Wallet: issued currencies, the immutable ledger and the generic escrow engine.
 * LedgerService = low-level money mechanics; CurrencyService = currency lifecycle + the
 * user-facing wallet; EscrowService = domain-agnostic escrow (agreement + per-leg holds) used by
 * Tasks today and Commerce/orders next. Exports Ledger & Escrow so other modules can compose them
 * inside their own transactions.
 */
@Module({
  controllers: [WalletController],
  providers: [LedgerService, CurrencyService, EscrowService, WalletCron],
  exports: [LedgerService, EscrowService],
})
export class WalletModule {}
