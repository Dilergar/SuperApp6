import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { CardSkinsService } from './card-skins.service';
import { CardSkinsController } from './card-skins.controller';

/**
 * Card Skins — platform-sold cosmetic skins for the PersonCard.
 * Imports WalletModule for the Ledger (purchases use the platform currency).
 * Exports the service so other modules (e.g. contacts overlay) can resolve skins.
 */
@Module({
  imports: [WalletModule],
  controllers: [CardSkinsController],
  providers: [CardSkinsService],
  exports: [CardSkinsService],
})
export class CardSkinsModule {}
