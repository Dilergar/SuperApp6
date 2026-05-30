import {
  Controller, Get, Post, Patch, Delete,
  Body, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  createCurrencySchema,
  updateCurrencySchema,
  mintSchema,
  burnSchema,
  payEmployeeSchema,
  walletHistoryQuerySchema,
} from '@superapp/shared';
import { CurrencyService } from './currency.service';
import { DatabaseService } from '../../shared/database/database.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly currency: CurrencyService,
    private readonly db: DatabaseService,
    private readonly wsContext: WorkspaceContextService,
  ) {}

  /** The active workspace, asserting the caller is its owner (B2B wallet is owner-only). */
  private async requireWorkspaceOwner(userId: string): Promise<string> {
    const workspaceId = this.wsContext.activeWorkspaceId;
    if (!workspaceId) throw new BadRequestException('Откройте организацию (контекст компании не активен)');
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
    if (!ws || ws.ownerId !== userId) throw new ForbiddenException('Только владелец компании управляет её кошельком');
    return workspaceId;
  }

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

  // ============================================================
  // Company (B2B) wallet — owner-only, in workspace context (X-Workspace-Id). Phase 9.
  // ============================================================

  @Get('company')
  @ApiOperation({ summary: 'Кошелёк компании: валюта + баланс казны' })
  async companyWallet(@CurrentUser() user: JwtPayload) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const [currency, treasury] = await Promise.all([
      this.currency.getCompanyCurrency(workspaceId),
      this.currency.getCompanyWallet(workspaceId),
    ]);
    return { success: true, data: { currency, treasury } };
  }

  @Post('company/currency')
  @ApiOperation({ summary: 'Создать валюту компании' })
  async createCompanyCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const data = createCurrencySchema.parse(body);
    return { success: true, data: await this.currency.createCompanyCurrency(workspaceId, data) };
  }

  @Patch('company/currency')
  @ApiOperation({ summary: 'Изменить валюту компании' })
  async renameCompanyCurrency(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const data = updateCurrencySchema.parse(body);
    return { success: true, data: await this.currency.renameCompanyCurrency(workspaceId, data) };
  }

  @Delete('company/currency')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить валюту компании (каскадно сгорает)' })
  async deleteCompanyCurrency(@CurrentUser() user: JwtPayload) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    await this.currency.deleteCompanyCurrency(workspaceId);
    return { success: true };
  }

  @Post('company/currency/mint')
  @ApiOperation({ summary: 'Выпустить монеты в казну компании (лимит 10М)' })
  async mintCompany(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const { amount } = mintSchema.parse(body);
    return { success: true, data: await this.currency.mintToTreasury(workspaceId, amount) };
  }

  @Post('company/pay')
  @ApiOperation({ summary: 'Начислить компанийные коины сотруднику из казны' })
  async payEmployee(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    const { userId, amount } = payEmployeeSchema.parse(body);
    return { success: true, data: await this.currency.payEmployee(workspaceId, userId, amount) };
  }

  @Get('company/holders')
  @ApiOperation({ summary: 'Держатели валюты компании' })
  async companyHolders(@CurrentUser() user: JwtPayload) {
    const workspaceId = await this.requireWorkspaceOwner(user.sub);
    return { success: true, data: await this.currency.getCompanyHolders(workspaceId) };
  }
}
