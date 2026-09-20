import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  equipDefaultSkinSchema,
  equipGroupSkinSchema,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import { CardSkinsService } from './card-skins.service';

@ApiTags('card-skins')
@Controller('card-skins')
export class CardSkinsController {
  constructor(private readonly skins: CardSkinsService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Card skin catalogue (with availability and ownership flags)' })
  async catalog(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.listCatalog(user.sub) };
  }

  @Get('wallet')
  @ApiOperation({ summary: 'Platform currency balance (used to buy skins)' })
  async wallet(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.getWallet(user.sub) };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post(':skinId/buy')
  @ApiOperation({ summary: 'Buy a skin (charges the currency, mints an instance with a serial number)' })
  async buy(@CurrentUser() user: JwtPayload, @Param('skinId') skinId: string) {
    return { success: true, data: await this.skins.buy(user.sub, skinId) };
  }

  @Get('inventory')
  @ApiOperation({ summary: 'My skins (instances)' })
  async inventory(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.listInventory(user.sub) };
  }

  @Get('equip')
  @ApiOperation({ summary: 'What is equipped now (default + per group + the premium flag)' })
  async equip(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.skins.getEquipState(user.sub) };
  }

  @Put('equip/default')
  @ApiOperation({ summary: 'Equip the default skin (null takes it off)' })
  async equipDefault(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { instanceId } = equipDefaultSkinSchema.parse(body);
    return { success: true, data: await this.skins.equipDefault(user.sub, instanceId) };
  }

  @Put('equip/group')
  @ApiOperation({ summary: 'Equip a skin for a group (premium; null takes it off)' })
  async equipGroup(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { circleId, instanceId } = equipGroupSkinSchema.parse(body);
    return { success: true, data: await this.skins.equipForGroup(user.sub, circleId, instanceId) };
  }

  @Get('resolve')
  @ApiOperation({ summary: 'Skins the viewer sees on the cards of the given people' })
  async resolve(@CurrentUser() user: JwtPayload, @Query('userIds') userIds?: string) {
    const ids = (userIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { success: true, data: await this.skins.resolveSkinsForViewer(user.sub, ids) };
  }
}
