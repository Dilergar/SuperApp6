import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import {
  createShowcaseSchema,
  updateShowcaseSchema,
  shareShowcaseSchema,
  createListingSchema,
  updateListingSchema,
  attachListingImageSchema,
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
  @ApiOperation({ summary: 'My shop (My Wish & Shop) + my showcases' })
  async getMyShop(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.getMyShop(user.sub);
    return { success: true, data };
  }

  @Get('accessible')
  @ApiOperation({ summary: 'Shops of other people available to me (the switcher)' })
  async accessible(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listAccessibleShops(user.sub);
    return { success: true, data };
  }

  @Get('currencies')
  @ApiOperation({ summary: 'Currencies for a listing price: mine + the currencies of people in my circle (Phase 5)' })
  async currencies(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.accessibleCurrencies(user.sub);
    return { success: true, data };
  }

  @Get('of/:ownerId')
  @ApiOperation({ summary: 'The shop of one person (only the showcases available to me)' })
  async getShopOf(@CurrentUser() user: JwtPayload, @Param('ownerId') ownerId: string) {
    const data = await this.shop.getShopOfUser(user.sub, ownerId);
    return { success: true, data };
  }

  // ---- Showcases ----
  @Post('showcases')
  @ApiOperation({ summary: 'Create a showcase' })
  async createShowcase(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createShowcaseSchema.parse(body);
    const showcase = await this.shop.createShowcase(user.sub, data);
    return { success: true, data: showcase };
  }

  @Patch('showcases/:id')
  @ApiOperation({ summary: 'Update a showcase' })
  async updateShowcase(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = updateShowcaseSchema.parse(body);
    const showcase = await this.shop.updateShowcase(user.sub, id, data);
    return { success: true, data: showcase };
  }

  @Delete('showcases/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a showcase' })
  async deleteShowcase(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.shop.deleteShowcase(user.sub, id);
    return { success: true };
  }

  @Get('showcases/:id/listings')
  @ApiOperation({ summary: 'Listings of a showcase (access-aware)' })
  async listListings(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.listListings(user.sub, id);
    return { success: true, data };
  }

  @Post('showcases/:id/shares')
  @ApiOperation({ summary: 'Share a showcase with a person or a group' })
  async share(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = shareShowcaseSchema.parse(body);
    const shares = await this.shop.shareShowcase(user.sub, id, data);
    return { success: true, data: shares };
  }

  @Delete('showcases/:id/shares/:principalType/:principalId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke access to a showcase' })
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
  @ApiOperation({ summary: 'Create a listing' })
  async createListing(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createListingSchema.parse(body);
    const listing = await this.shop.createListing(user.sub, data);
    return { success: true, data: listing };
  }

  @Patch('listings/:id')
  @ApiOperation({ summary: 'Update a listing' })
  async updateListing(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = updateListingSchema.parse(body);
    const listing = await this.shop.updateListing(user.sub, id, data);
    return { success: true, data: listing };
  }

  @Delete('listings/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a listing' })
  async deleteListing(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.shop.deleteListing(user.sub, id);
    return { success: true };
  }

  // ---- Галерея лота (движок файлов, профиль listing_image, ≤10 фото) ----

  @Get('listings/:id/images')
  @ApiOperation({ summary: 'Listing photos (gallery; the first one is the cover)' })
  async listingImages(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.shop.getListingImages(user.sub, id) };
  }

  @Post('listings/:id/images')
  @ApiOperation({ summary: 'Attach a photo to a listing (the file is already uploaded by the engine)' })
  async attachListingImage(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { fileId } = attachListingImageSchema.parse(body);
    return { success: true, data: await this.shop.attachListingImage(user.sub, id, fileId) };
  }

  @Delete('listings/:id/images/:fileId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a photo from the listing gallery' })
  async removeListingImage(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ) {
    await this.shop.removeListingImage(user.sub, id, fileId);
    return { success: true };
  }

  // ---- Staff ----
  @Get('staff')
  @ApiOperation({ summary: 'Staff of the shop and its showcases' })
  async listStaff(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listStaff(user.sub);
    return { success: true, data };
  }

  @Post('staff')
  @ApiOperation({ summary: 'Assign a shop / showcase staff member (from the circle)' })
  async assignStaff(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = assignShopStaffSchema.parse(body);
    await this.shop.assignStaff(user.sub, data);
    return { success: true };
  }

  @Delete('staff/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a staff member' })
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
  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('listings/:id/buy')
  @ApiOperation({ summary: 'Buy a listing (the price is held in escrow)' })
  async buy(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.buy(user.sub, id);
    return { success: true, data };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('listings/:id/contribute')
  @ApiOperation({ summary: 'Chip in on a crowdfunding listing (the pledge is held)' })
  async contribute(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = contributeSchema.parse(body);
    const order = await this.shop.contribute(user.sub, id, data.contributions);
    return { success: true, data: order };
  }

  @Get('orders')
  @ApiOperation({ summary: 'My orders (as a buyer)' })
  async myOrders(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listMyOrders(user.sub);
    return { success: true, data };
  }

  @Get('orders/incoming')
  @ApiOperation({ summary: 'Orders on my shops (confirm / reject)' })
  async incomingOrders(@CurrentUser() user: JwtPayload) {
    const data = await this.shop.listIncomingOrders(user.sub);
    return { success: true, data };
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Order / campaign details (progress per currency + contributors)' })
  async orderDetail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.getOrderDetail(user.sub, id);
    return { success: true, data };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('orders/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an order → payout to the seller' })
  async confirmOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.confirmOrder(user.sub, id);
    return { success: true, data };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('orders/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject an order → refund to the buyer' })
  async rejectOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.rejectOrder(user.sub, id);
    return { success: true, data };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel my unconfirmed order → refund' })
  async cancelOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.cancelOrder(user.sub, id);
    return { success: true, data };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('orders/:id/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund an order in progress (owner / co-manager) → the hold is released' })
  async refundOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.refundOrder(user.sub, id);
    return { success: true, data };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('orders/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my pledge from a crowdfunding campaign → refund' })
  async withdraw(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shop.withdraw(user.sub, id);
    return { success: true, data };
  }

  // ---- Wishlist (Phase 8) ----
  @Get('wishes')
  @ApiOperation({ summary: 'My wishlist (wishes + audience)' })
  async myWishes(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.shop.listMyWishes(user.sub) };
  }

  @Post('wishes')
  @ApiOperation({ summary: 'Add a wish' })
  async createWish(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createWishSchema.parse(body);
    return { success: true, data: await this.shop.createWish(user.sub, data) };
  }

  @Post('wishes/shares')
  @ApiOperation({ summary: 'Share the wishlist (a person / a group)' })
  async shareWishlist(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = shareShowcaseSchema.parse(body);
    return { success: true, data: await this.shop.shareWishlist(user.sub, data) };
  }

  @Delete('wishes/shares/:principalType/:principalId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke access to the wishlist' })
  async unshareWishlist(@CurrentUser() user: JwtPayload, @Param('principalType') principalType: string, @Param('principalId') principalId: string) {
    return { success: true, data: await this.shop.unshareWishlist(user.sub, principalType, principalId) };
  }

  // Деньги: эскроу и движение коинов — необратимо. Ключ ОБЯЗАТЕЛЕН; второй ремень —
  // производный ключ на самой проводке леджера (docs/idempotency_engine.md).
  @Idempotent({ required: true })
  @Post('wishes/:id/fulfill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a wish fulfilled' })
  async fulfillWish(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.shop.fulfillWish(user.sub, id) };
  }

  @Post('wishes/:id/copy')
  @ApiOperation({ summary: 'Add a wish of another person to my showcase (a listing)' })
  async copyWish(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = copyWishSchema.parse(body);
    return { success: true, data: await this.shop.copyWishToShowcase(user.sub, id, data) };
  }

  @Patch('wishes/:id')
  @ApiOperation({ summary: 'Update a wish' })
  async updateWish(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const data = updateWishSchema.parse(body);
    return { success: true, data: await this.shop.updateWish(user.sub, id, data) };
  }

  @Delete('wishes/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a wish' })
  async deleteWish(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.shop.deleteWish(user.sub, id);
    return { success: true };
  }

  @Get('wishlists/accessible')
  @ApiOperation({ summary: 'Wishlists of other people available to me' })
  async accessibleWishlists(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.shop.accessibleWishlists(user.sub) };
  }

  @Get('wishlists/of/:ownerId')
  @ApiOperation({ summary: 'The wishlist of one person (active wishes)' })
  async wishlistOf(@CurrentUser() user: JwtPayload, @Param('ownerId') ownerId: string) {
    return { success: true, data: await this.shop.wishlistOf(user.sub, ownerId) };
  }
}
