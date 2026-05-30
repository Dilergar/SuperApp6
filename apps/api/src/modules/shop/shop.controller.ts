import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  createShowcaseSchema,
  updateShowcaseSchema,
  shareShowcaseSchema,
  createListingSchema,
  updateListingSchema,
  assignShopStaffSchema,
  contributeSchema,
  createWishSchema,
  updateWishSchema,
  copyWishSchema,
} from '@superapp/shared';
import { ShopService } from './shop.service';

@ApiTags('Shop')
@ApiBearerAuth()
@Controller('shop')
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  @Get()
  @ApiOperation({ summary: 'Мой магазин (My Wish & Shop) + мои витрины' })
  async getMyShop(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.getMyShop(user.sub);
    return { success: true, data };
  }

  @Get('accessible')
  @ApiOperation({ summary: 'Магазины других, доступные мне (переключатель)' })
  async accessible(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listAccessibleShops(user.sub);
    return { success: true, data };
  }

  @Get('currencies')
  @ApiOperation({ summary: 'Валюты для цены лота: моя + валюты людей из окружения (Phase 5)' })
  async currencies(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.accessibleCurrencies(user.sub);
    return { success: true, data };
  }

  @Get('of/:ownerId')
  @ApiOperation({ summary: 'Магазин конкретного человека (только доступные витрины)' })
  async getShopOf(@CurrentUser() user: JwtPayload, @Param('ownerId') ownerId: string) {
    const data = await this.shop.getShopOfUser(user.sub, ownerId);
    return { success: true, data };
  }

  // ---- Showcases ----
  @Post('showcases')
  @ApiOperation({ summary: 'Создать витрину' })
  async createShowcase(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createShowcaseSchema.parse(body);
    const showcase = await this.shop.createShowcase(user.sub, data);
    return { success: true, data: showcase };
  }

  @Patch('showcases/:id')
  @ApiOperation({ summary: 'Обновить витрину' })
  async updateShowcase(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = updateShowcaseSchema.parse(body);
    const showcase = await this.shop.updateShowcase(user.sub, id, data);
    return { success: true, data: showcase };
  }

  @Delete('showcases/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить витрину' })
  async deleteShowcase(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.shop.deleteShowcase(user.sub, id);
    return { success: true };
  }

  @Get('showcases/:id/listings')
  @ApiOperation({ summary: 'Товары витрины (с учётом доступа)' })
  async listListings(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.listListings(user.sub, id);
    return { success: true, data };
  }

  @Post('showcases/:id/shares')
  @ApiOperation({ summary: 'Поделиться витриной с человеком или Группой' })
  async share(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = shareShowcaseSchema.parse(body);
    const shares = await this.shop.shareShowcase(user.sub, id, data);
    return { success: true, data: shares };
  }

  @Delete('showcases/:id/shares/:principalType/:principalId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Убрать доступ к витрине' })
  async unshare(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('principalType') principalType: string,
    @Param('principalId') principalId: string,
  ) {
    const shares = await this.shop.unshareShowcase(user.sub, id, principalType, principalId);
    return { success: true, data: shares };
  }

  // ---- Listings ----
  @Post('listings')
  @ApiOperation({ summary: 'Создать товар (лот)' })
  async createListing(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createListingSchema.parse(body);
    const listing = await this.shop.createListing(user.sub, data);
    return { success: true, data: listing };
  }

  @Patch('listings/:id')
  @ApiOperation({ summary: 'Обновить товар' })
  async updateListing(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = updateListingSchema.parse(body);
    const listing = await this.shop.updateListing(user.sub, id, data);
    return { success: true, data: listing };
  }

  @Delete('listings/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить товар' })
  async deleteListing(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.shop.deleteListing(user.sub, id);
    return { success: true };
  }

  // ---- Staff ----
  @Get('staff')
  @ApiOperation({ summary: 'Сотрудники магазина и витрин' })
  async listStaff(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listStaff(user.sub);
    return { success: true, data };
  }

  @Post('staff')
  @ApiOperation({ summary: 'Назначить сотрудника магазина/витрины (из Окружения)' })
  async assignStaff(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = assignShopStaffSchema.parse(body);
    await this.shop.assignStaff(user.sub, data);
    return { success: true };
  }

  @Delete('staff/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Снять сотрудника' })
  async revokeStaff(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
    @Query('scope') scope: string,
    @Query('showcaseId') showcaseId?: string,
  ) {
    await this.shop.revokeStaff(user.sub, userId, scope ?? 'shop', showcaseId);
    return { success: true };
  }

  // ---- Orders (Phase 3: purchase with escrow) ----
  @Post('listings/:id/buy')
  @ApiOperation({ summary: 'Купить лот (заморозка цены в эскроу)' })
  async buy(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.buy(user.sub, id);
    return { success: true, data };
  }

  @Post('listings/:id/contribute')
  @ApiOperation({ summary: 'Скинуться на краудфандинговый лот (заморозка вклада)' })
  async contribute(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = contributeSchema.parse(body);
    const order = await this.shop.contribute(user.sub, id, data.contributions);
    return { success: true, data: order };
  }

  @Get('orders')
  @ApiOperation({ summary: 'Мои заказы (как покупатель)' })
  async myOrders(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listMyOrders(user.sub);
    return { success: true, data };
  }

  @Get('orders/incoming')
  @ApiOperation({ summary: 'Заказы на мои магазины (подтвердить/отклонить)' })
  async incomingOrders(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listIncomingOrders(user.sub);
    return { success: true, data };
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Детали заказа/кампании (прогресс по валютам + вкладчики)' })
  async orderDetail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.getOrderDetail(user.sub, id);
    return { success: true, data };
  }

  @Post('orders/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Подтвердить заказ → списание продавцу' })
  async confirmOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.confirmOrder(user.sub, id);
    return { success: true, data };
  }

  @Post('orders/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отклонить заказ → возврат покупателю' })
  async rejectOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.rejectOrder(user.sub, id);
    return { success: true, data };
  }

  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить свой неподтверждённый заказ → возврат' })
  async cancelOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.cancelOrder(user.sub, id);
    return { success: true, data };
  }

  @Post('orders/:id/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вернуть заказ «в работе» (владелец/соуправляющий) → разморозка' })
  async refundOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.refundOrder(user.sub, id);
    return { success: true, data };
  }

  @Post('orders/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отозвать свой вклад из краудфандинг-кампании → возврат' })
  async withdraw(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.withdraw(user.sub, id);
    return { success: true, data };
  }

  // ---- Wishlist (Phase 8) ----
  @Get('wishes')
  @ApiOperation({ summary: 'Мой вишлист (хотелки + аудитория)' })
  async myWishes(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.shop.listMyWishes(user.sub) };
  }

  @Post('wishes')
  @ApiOperation({ summary: 'Добавить хотелку' })
  async createWish(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createWishSchema.parse(body);
    return { success: true, data: await this.shop.createWish(user.sub, data) };
  }

  @Post('wishes/shares')
  @ApiOperation({ summary: 'Поделиться вишлистом (человек/Группа)' })
  async shareWishlist(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = shareShowcaseSchema.parse(body);
    return { success: true, data: await this.shop.shareWishlist(user.sub, data) };
  }

  @Delete('wishes/shares/:principalType/:principalId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Убрать доступ к вишлисту' })
  async unshareWishlist(@CurrentUser() user: JwtPayload, @Param('principalType') principalType: string, @Param('principalId') principalId: string) {
    return { success: true, data: await this.shop.unshareWishlist(user.sub, principalType, principalId) };
  }

  @Post('wishes/:id/fulfill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отметить хотелку исполненной' })
  async fulfillWish(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.shop.fulfillWish(user.sub, id) };
  }

  @Post('wishes/:id/copy')
  @ApiOperation({ summary: 'Добавить чужую хотелку в свою витрину (→ лот)' })
  async copyWish(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = copyWishSchema.parse(body);
    return { success: true, data: await this.shop.copyWishToShowcase(user.sub, id, data) };
  }

  @Patch('wishes/:id')
  @ApiOperation({ summary: 'Изменить хотелку' })
  async updateWish(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = updateWishSchema.parse(body);
    return { success: true, data: await this.shop.updateWish(user.sub, id, data) };
  }

  @Delete('wishes/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить хотелку' })
  async deleteWish(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.shop.deleteWish(user.sub, id);
    return { success: true };
  }

  @Get('wishlists/accessible')
  @ApiOperation({ summary: 'Чужие вишлисты, доступные мне' })
  async accessibleWishlists(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.shop.accessibleWishlists(user.sub) };
  }

  @Get('wishlists/of/:ownerId')
  @ApiOperation({ summary: 'Вишлист человека (активные хотелки)' })
  async wishlistOf(@CurrentUser() user: JwtPayload, @Param('ownerId') ownerId: string) {
    return { success: true, data: await this.shop.wishlistOf(user.sub, ownerId) };
  }
}
