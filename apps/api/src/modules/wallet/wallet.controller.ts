import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import { badRequest, forbidden } from '../../shared/errors/api-error';
import {
  createCurrencySchema,
  updateCurrencySchema,
  mintSchema,
  burnSchema,
  payEmployeeSchema,
  walletHistoryQuerySchema,
  createPaymentCardSchema,
  updatePaymentCardSchema,
  type CompanyWalletDto,
} from '@superapp/shared';
import { CurrencyService } from './currency.service';
import { PaymentCardsService } from './payment-cards.service';
import { DatabaseService } from '../../shared/database/database.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly currency: CurrencyService,
    private readonly cards: PaymentCardsService,
    private readonly db: DatabaseService,
    private readonly wsContext: WorkspaceContextService,
  ) {}

  // ============================================================
  // Карты — реквизит для выплат (без CVV; платежи через них не проводятся)
  // ============================================================

  @Get('cards')
  @ApiOperation({ summary: 'My cards (full number — to the owner)' })
  async listCards(@CurrentUser() user: JwtPayload) {
    const data = await this.cards.list(user.sub);
    return { success: true, data };
  }

  @Post('cards')
  @ApiOperation({ summary: 'Add a card (number + card account IBAN, expiry, holder; NO CVV)' })
  async createCard(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = createPaymentCardSchema.parse(body);
    const data = await this.cards.create(user.sub, dto);
    return { success: true, data };
  }

  @Patch('cards/:id')
  @ApiOperation({ summary: 'Update a card (expiry, holder, primary); the number is immutable' })
  async updateCard(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = updatePaymentCardSchema.parse(body);
    const data = await this.cards.update(user.sub, id, dto);
    return { success: true, data };
  }

  @Delete('cards/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a card' })
  async removeCard(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.cards.remove(user.sub, id);
    return { success: true };
  }

  /** The active workspace, asserting the caller is its owner (B2B wallet is owner-only). */
  private async requireWorkspaceOwner(userId: string): Promise<string> {
    const workspaceId = this.wsContext.activeWorkspaceId;
    if (!workspaceId) throw badRequest('workspace.contextRequired');
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
    if (!ws || ws.ownerId !== userId) throw forbidden('wallet.ownerOnly');
    return workspaceId;
  }

  @Get()
  @ApiOperation({ summary: 'My wallet — every currency with its balance (own currency first)' })
  async getWallet(@CurrentUser() user: JwtPayload) {
    const data = await this.currency.getWallet(user.sub);
    return { success: true, data };
  }

  @Get('history')
  @ApiOperation({ summary: 'Transaction history (cursor pagination)' })
  async getHistory(
    @CurrentUser() user: JwtPayload,
    @Query('currencyId') currencyId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const q = walletHistoryQuerySchema.parse({ currencyId, cursor, limit });
    return { success: true, data: await this.currency.getHistory(user.sub, q) };
  }

  @Get('currency')
  @ApiOperation({ summary: 'The currency I issued (or null)' })
  async getMyCurrency(@CurrentUser() user: JwtPayload) {
    const data = await this.currency.getMyCurrency(user.sub);
    return { success: true, data };
  }

  @Post('currency')
  @ApiOperation({ summary: 'Create my own currency (name + emoji)' })
  async createCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createCurrencySchema.parse(body);
    const currency = await this.currency.createCurrency(user.sub, data);
    return { success: true, data: currency };
  }

  @Patch('currency')
  @ApiOperation({ summary: 'Rename the currency (once per 3 months, retroactive)' })
  async updateCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = updateCurrencySchema.parse(body);
    const currency = await this.currency.renameCurrency(user.sub, data);
    return { success: true, data: currency };
  }

  @Delete('currency')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete the currency — it burns for every holder' })
  async deleteCurrency(@CurrentUser() user: JwtPayload) {
    await this.currency.deleteCurrency(user.sub);
    return { success: true };
  }

  // Деньги: необратимо и неотменяемо. Ключ ОБЯЗАТЕЛЕН, ровно одна транзакция
  // (`atomic`), второй ремень — производный ключ на самой проводке леджера.
  @Idempotent({ required: true, atomic: true })
  @Post('currency/mint')
  @ApiOperation({ summary: 'Mint coins onto my own balance (10M in-hand cap)' })
  async mint(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { amount } = mintSchema.parse(body);
    const data = await this.currency.mint(user.sub, amount);
    return { success: true, data };
  }

  @Get('currency/holders')
  @ApiOperation({ summary: 'Holders of my currency (issuer only)' })
  async getHolders(@CurrentUser() user: JwtPayload) {
    const data = await this.currency.getHolders(user.sub);
    return { success: true, data };
  }

  // Деньги: необратимо и неотменяемо. Ключ ОБЯЗАТЕЛЕН, ровно одна транзакция
  // (`atomic`), второй ремень — производный ключ на самой проводке леджера.
  @Idempotent({ required: true, atomic: true })
  @Post('burn')
  @ApiOperation({ summary: "Burn someone else's currency from my balance (irreversible)" })
  async burn(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { currencyId, amount } = burnSchema.parse(body);
    const data = await this.currency.burn(user.sub, currencyId, amount);
    return { success: true, data };
  }

  // ============================================================
  // Company (B2B) wallet — owner-only, in workspace context (X-Workspace-Id). Phase 9.
  // ============================================================

  @Get('company')
  @ApiOperation({ summary: 'Company wallet: currency + treasury balance' })
  async companyWallet(@CurrentUser() user: JwtPayload) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const [currency, treasury] = await Promise.all([
      this.currency.getCompanyCurrency(workspaceId),
      this.currency.getCompanyWallet(workspaceId),
    ]);
    const data: CompanyWalletDto = { currency, treasury };
    return { success: true, data };
  }

  @Post('company/currency')
  @ApiOperation({ summary: 'Create the company currency' })
  async createCompanyCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const data = createCurrencySchema.parse(body);
    return { success: true, data: await this.currency.createCompanyCurrency(workspaceId, data) };
  }

  @Patch('company/currency')
  @ApiOperation({ summary: 'Rename the company currency' })
  async renameCompanyCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const data = updateCurrencySchema.parse(body);
    return { success: true, data: await this.currency.renameCompanyCurrency(workspaceId, data) };
  }

  @Delete('company/currency')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete the company currency (it burns for every holder)' })
  async deleteCompanyCurrency(@CurrentUser() user: JwtPayload) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    await this.currency.deleteCompanyCurrency(workspaceId);
    return { success: true };
  }

  // Деньги: необратимо и неотменяемо. Ключ ОБЯЗАТЕЛЕН, ровно одна транзакция
  // (`atomic`), второй ремень — производный ключ на самой проводке леджера.
  @Idempotent({ required: true, atomic: true })
  @Post('company/currency/mint')
  @ApiOperation({ summary: 'Mint coins into the company treasury (10M cap)' })
  async mintCompany(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const { amount } = mintSchema.parse(body);
    return { success: true, data: await this.currency.mintToTreasury(workspaceId, amount) };
  }

  // Деньги: необратимо и неотменяемо. Ключ ОБЯЗАТЕЛЕН, ровно одна транзакция
  // (`atomic`), второй ремень — производный ключ на самой проводке леджера.
  @Idempotent({ required: true, atomic: true })
  @Post('company/pay')
  @ApiOperation({ summary: 'Pay company coins to an employee from the treasury' })
  async payEmployee(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const { userId, amount } = payEmployeeSchema.parse(body);
    return { success: true, data: await this.currency.payEmployee(workspaceId, userId, amount) };
  }

  @Get('company/holders')
  @ApiOperation({ summary: 'Holders of the company currency' })
  async companyHolders(@CurrentUser() user: JwtPayload) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    return { success: true, data: await this.currency.getCompanyHolders(workspaceId) };
  }
}
