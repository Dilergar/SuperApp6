import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { topUpSkinWalletSchema } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { notFound } from '../../shared/errors/api-error';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { CardSkinsService } from './card-skins.service';

/**
 * Дев-полигон скинов (только development/test, регистрируется модулем лишь в dev):
 * тестовое пополнение платформенной валюты. Это ЧЕКАНКА денег без оплаты — в production
 * контроллера нет вовсе (маршрут = 404), а `assertDev` — второй слой на случай, если
 * контроллер когда-нибудь зарегистрируют мимо условия модуля.
 * Настоящее пополнение появится вместе с платёжным рельсом.
 */
@ApiTags('card-skins')
@ApiBearerAuth()
@Controller('card-skins')
export class CardSkinsDevController {
  constructor(private readonly skins: CardSkinsService) {}

  @Post('wallet/topup')
  @ApiOperation({ summary: '[dev] Top up the platform currency without payment' })
  async topup(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    if (!isDevEnv()) throw notFound('dev.developmentOnly');
    const { amount } = topUpSkinWalletSchema.parse(body);
    return { success: true, data: await this.skins.devTopUp(user.sub, amount) };
  }
}
