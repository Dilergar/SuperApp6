import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { CurrencyService } from './currency.service';
import { EscrowService } from './escrow.service';
import { PaymentCardsService } from './payment-cards.service';
import { WalletController } from './wallet.controller';
import { WalletCron } from './wallet.cron';

/**
 * Wallet: issued currencies, the immutable ledger and the generic escrow engine.
 * LedgerService = low-level money mechanics; CurrencyService = currency lifecycle + the
 * user-facing wallet; EscrowService = domain-agnostic escrow (agreement + per-leg holds) used by
 * Tasks today and Commerce/orders next. Exports Ledger & Escrow so other modules can compose them
 * inside their own transactions.
 *
 * PaymentCardsService — карты-«реквизиты» человека (без CVV, шифрование в БД);
 * экспортируется для ростера «Сотрудники» (реквизитный блок manager+).
 */
@Module({
  controllers: [WalletController],
  providers: [LedgerService, CurrencyService, EscrowService, PaymentCardsService, WalletCron],
  exports: [LedgerService, EscrowService, PaymentCardsService],
})
export class WalletModule {}
