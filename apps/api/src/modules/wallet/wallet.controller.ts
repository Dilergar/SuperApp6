import {
  Controller, Get, Post, Patch, Delete,
  Body, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  createCurrencySchema,
  updateCurrencySchema,
  mintSchema,
  burnSchema,
  walletHistoryQuerySchema,
} from '@superapp/shared';
import { CurrencyService } from './currency.service';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly currency: CurrencyService) {}

  @Get()
  @ApiOperation({ summary: 'Мой кошелёк — все валюты с балансами (своя всегда первой)' })
  async getWallet(@CurrentUser() user: JwtPayload) {
    const data = await this.currency.getWallet(user.sub);
    return { success: true, data };
  }

  @Get('history')
  @ApiOperation({ summary: 'История транзакций (курсорная пагинация)' })
  async getHistory(
    @CurrentUser() user: JwtPayload,
    @Query('currencyId') currencyId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const q = walletHistoryQuerySchema.parse({ currencyId, cursor, limit });
    const { items, nextCursor } = await this.currency.getHistory(user.sub, q);
    return { success: true, data: items, nextCursor };
  }

  @Get('currency')
  @ApiOperation({ summary: 'Моя выпущенная валюта (или null)' })
  async getMyCurrency(@CurrentUser() user: JwtPayload) {
    const data = await this.currency.getMyCurrency(user.sub);
    return { success: true, data };
  }

  @Post('currency')
  @ApiOperation({ summary: 'Создать свою валюту (название + эмодзи)' })
  async createCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createCurrencySchema.parse(body);
    const currency = await this.currency.createCurrency(user.sub, data);
    return { success: true, data: currency };
  }

  @Patch('currency')
  @ApiOperation({ summary: 'Изменить валюту (раз в 3 месяца, ретроспективно)' })
  async updateCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = updateCurrencySchema.parse(body);
    const currency = await this.currency.renameCurrency(user.sub, data);
    return { success: true, data: currency };
  }

  @Delete('currency')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить валюту — каскадно сгорает у всех держателей' })
  async deleteCurrency(@CurrentUser() user: JwtPayload) {
    await this.currency.deleteCurrency(user.sub);
    return { success: true };
  }

  @Post('currency/mint')
  @ApiOperation({ summary: 'Выпустить монеты себе на баланс (лимит 10М «на руках»)' })
  async mint(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { amount } = mintSchema.parse(body);
    const data = await this.currency.mint(user.sub, amount);
    return { success: true, data };
  }

  @Get('currency/holders')
  @ApiOperation({ summary: 'Держатели моей валюты (видно только эмитенту)' })
  async getHolders(@CurrentUser() user: JwtPayload) {
    const data = await this.currency.getHolders(user.sub);
    return { success: true, data };
  }

  @Post('burn')
  @ApiOperation({ summary: 'Сжечь чужую валюту со своего баланса (необратимо)' })
  async burn(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { currencyId, amount } = burnSchema.parse(body);
    const data = await this.currency.burn(user.sub, currencyId, amount);
    return { success: true, data };
  }
}
