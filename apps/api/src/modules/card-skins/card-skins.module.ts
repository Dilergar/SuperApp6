import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { CardSkinsService } from './card-skins.service';
import { CardSkinsController } from './card-skins.controller';
import { CardSkinsDevController } from './card-skins.dev';
import { isDevEnv } from '../../shared/config/env.validation';

/**
 * Card Skins — platform-sold cosmetic skins for the PersonCard.
 * Imports WalletModule for the Ledger (purchases use the platform currency).
 * Exports the service so other modules (e.g. contacts overlay) can resolve skins.
 *
 * Тестовое пополнение (чеканка валюты без оплаты) живёт в отдельном дев-контроллере и
 * регистрируется ТОЛЬКО в development/test — в остальных средах маршрута нет (404).
 */
@Module({
  imports: [WalletModule],
  controllers: isDevEnv() ? [CardSkinsDevController, CardSkinsController] : [CardSkinsController],
  providers: [CardSkinsService],
  exports: [CardSkinsService],
})
export class CardSkinsModule {}
