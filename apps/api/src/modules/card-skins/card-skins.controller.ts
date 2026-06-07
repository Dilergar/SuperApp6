import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  topUpSkinWalletSchema,
  equipDefaultSkinSchema,
  equipGroupSkinSchema,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { CardSkinsService } from './card-skins.service';

@ApiTags('card-skins')
@Controller('card-skins')
export class CardSkinsController {
  constructor(private readonly skins: CardSkinsService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Каталог скинов карточки (с флагами доступности/владения)' })
  async catalog(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.listCatalog(user.sub) };
  }

  @Get('wallet')
  @ApiOperation({ summary: 'Баланс платформенной валюты (для покупки скинов)' })
  async wallet(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.getWallet(user.sub) };
  }

  @Post('wallet/topup')
  @ApiOperation({ summary: 'ТЕСТ: пополнить платформенную валюту (реальная оплата — позже)' })
  async topup(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { amount } = topUpSkinWalletSchema.parse(body);
    return { success: true, data: await this.skins.topUp(user.sub, amount) };
  }

  @Post(':skinId/buy')
  @ApiOperation({ summary: 'Купить скин (списывает валюту, выдаёт экземпляр с серийником)' })
  async buy(@CurrentUser() user: JwtPayload, @Param('skinId') skinId: string) {
    return { success: true, data: await this.skins.buy(user.sub, skinId) };
  }

  @Get('inventory')
  @ApiOperation({ summary: 'Мои скины (экземпляры)' })
  async inventory(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.listInventory(user.sub) };
  }

  @Get('equip')
  @ApiOperation({ summary: 'Текущее надевание (дефолт + по группам + флаг премиума)' })
  async equip(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.getEquipState(user.sub) };
  }

  @Put('equip/default')
  @ApiOperation({ summary: 'Надеть скин по умолчанию (или null — снять)' })
  async equipDefault(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { instanceId } = equipDefaultSkinSchema.parse(body);
    return { success: true, data: await this.skins.equipDefault(user.sub, instanceId) };
  }

  @Put('equip/group')
  @ApiOperation({ summary: 'Надеть скин на группу (премиум; или null — снять)' })
  async equipGroup(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { circleId, instanceId } = equipGroupSkinSchema.parse(body);
    return { success: true, data: await this.skins.equipForGroup(user.sub, circleId, instanceId) };
  }

  @Get('resolve')
  @ApiOperation({ summary: 'Скины, которые видит зритель на карточках указанных людей' })
  async resolve(@CurrentUser() user: JwtPayload, @Query('userIds') userIds?: string) {
    const ids = (userIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { success: true, data: await this.skins.resolveSkinsForViewer(user.sub, ids) };
  }
}
