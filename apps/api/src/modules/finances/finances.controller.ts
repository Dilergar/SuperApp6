import {
  Controller, Get, Post, Patch, Put, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { badRequest } from '../../shared/errors/api-error';
import {
  createFinAccountSchema,
  updateFinAccountSchema,
  setFinAccountBalanceSchema,
  createFinCategorySchema,
  updateFinCategorySchema,
  createFinTransactionSchema,
  updateFinTransactionSchema,
  listFinTransactionsQuerySchema,
  upsertFinBudgetSchema,
  finMonthReportQuerySchema,
  finTrendQuerySchema,
  addFinPersonSchema,
  finPeopleReportQuerySchema,
  createFinDebtSchema,
  payFinDebtSchema,
  updateFinDebtSchema,
  createFinRecurringSchema,
  updateFinRecurringSchema,
  upsertFinShareSchema,
  finCoinFeedQuerySchema,
} from '@superapp/shared';
import { FinancesService } from './finances.service';

/**
 * «Финансы» — thin controllers (Zod parse → service), AI-ready by design (Принцип 4):
 * every operation is programmatically callable. `?bookId=` targets a foreign shared book
 * (Phase 6); omitted → the caller's own book (lazy-created).
 */
@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance')
export class FinancesController {
  constructor(private readonly finances: FinancesService) {}

  @Get()
  @ApiOperation({ summary: 'Book overview: accounts with balances + the category tree (lazily creates the book)' })
  async getOverview(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.getOverview(user.sub, bookId || undefined);
    return { success: true, data };
  }

  // ---------- accounts ----------

  @Post('accounts')
  @ApiOperation({ summary: 'Create an account (cash / card / savings) with an optional opening balance' })
  async createAccount(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = createFinAccountSchema.parse(body);
    const data = await this.finances.createAccount(user.sub, dto, bookId || undefined);
    return { success: true, data };
  }

  @Post('accounts/:id/set-balance')
  @ApiOperation({ summary: '"I now have N on the account" — a balance adjustment (double entry via the opening balance)' })
  async setAccountBalance(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const { balance } = setFinAccountBalanceSchema.parse(body);
    const data = await this.finances.setAccountBalance(user.sub, id, balance, bookId || undefined);
    return { success: true, data };
  }

  @Patch('accounts/:id')
  @ApiOperation({ summary: 'Update an account (name / icon / archive / order)' })
  async updateAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = updateFinAccountSchema.parse(body);
    const data = await this.finances.updateAccount(user.sub, id, dto, bookId || undefined);
    return { success: true, data };
  }

  @Delete('accounts/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an account (one with history is archived)' })
  async deleteAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.deleteAccount(user.sub, id, bookId || undefined);
    return { success: true, data };
  }

  // ---------- categories ----------

  @Post('categories')
  @ApiOperation({ summary: 'Create an expense / income category (tree up to 2 levels)' })
  async createCategory(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = createFinCategorySchema.parse(body);
    const data = await this.finances.createCategory(user.sub, dto, bookId || undefined);
    return { success: true, data };
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update a category (name / icon / archive / parent)' })
  async updateCategory(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = updateFinCategorySchema.parse(body);
    const data = await this.finances.updateCategory(user.sub, id, dto, bookId || undefined);
    return { success: true, data };
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a category (one with history is archived; one with children returns 409)' })
  async deleteCategory(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.deleteCategory(user.sub, id, bookId || undefined);
    return { success: true, data };
  }

  // ---------- budgets + reports (план-факт) ----------

  @Put('budgets')
  @ApiOperation({ summary: 'Set or update a category budget for a month (amount=null deletes it)' })
  async upsertBudget(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = upsertFinBudgetSchema.parse(body);
    const data = await this.finances.upsertBudget(user.sub, dto, bookId || undefined);
    return { success: true, data };
  }

  @Get('reports/month')
  @ApiOperation({ summary: 'Month report: categories (actual), income, debt payments, budget plan vs fact' })
  async monthReport(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finMonthReportQuerySchema.parse(rawQuery);
    const data = await this.finances.getMonthReport(user.sub, q.period, q.bookId);
    return { success: true, data };
  }

  @Get('reports/trend')
  @ApiOperation({ summary: 'Month-by-month trend: expense / income (per currency)' })
  async trend(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finTrendQuerySchema.parse(rawQuery);
    const data = await this.finances.getTrend(user.sub, q.months ?? 6, q.bookId);
    return { success: true, data };
  }

  // ---------- people («Близкие» + отчёт по людям) ----------

  @Get('people')
  @ApiOperation({ summary: 'Close people — the quick-pick list for the "who" field' })
  async listPeople(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listPeople(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('people')
  @ApiOperation({ summary: 'Add a person from the circle to close people' })
  async addPerson(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const { userId } = addFinPersonSchema.parse(body);
    const data = await this.finances.addPerson(user.sub, userId, bookId || undefined);
    return { success: true, data };
  }

  @Delete('people/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a person from close people (the transaction history is untouched)' })
  async removePerson(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.removePerson(user.sub, userId, bookId || undefined);
    return { success: true, data };
  }

  @Get('reports/people')
  @ApiOperation({ summary: 'People report: how much was spent on / received from each person' })
  async peopleReport(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finPeopleReportQuerySchema.parse(rawQuery);
    const data = await this.finances.getPeopleReport(user.sub, q, q.bookId);
    return { success: true, data };
  }

  // ---------- coins: авто-лента экосистемы (проекция кошелька, только своя) ----------

  @Get('coins')
  @ApiOperation({ summary: 'Ecosystem coin feed: task rewards, purchases, treasury — from the ledger, with context' })
  async coinFeed(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finCoinFeedQuerySchema.parse(rawQuery);
    // Страница цельной в `data` (вариант A): контроллер её не расплющивает.
    return { success: true, data: await this.finances.getCoinFeed(user.sub, q.cursor, q.limit ?? 30) };
  }

  // ---------- shares (семейный доступ) ----------

  @Get('shares')
  @ApiOperation({ summary: 'Who my book is open to (people and groups, the viewer / editor roles)' })
  async listShares(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listShares(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('shares')
  @ApiOperation({ summary: 'Grant book access to a person from the circle or to a group' })
  async addShare(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = upsertFinShareSchema.parse(body);
    const data = await this.finances.addShare(user.sub, dto, bookId || undefined);
    return { success: true, data };
  }

  @Delete('shares/:principalType/:principalId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke access' })
  async removeShare(
    @CurrentUser() user: JwtPayload,
    @Param('principalType') principalType: string,
    @Param('principalId') principalId: string,
    @Query('bookId') bookId?: string,
  ) {
    if (principalType !== 'user' && principalType !== 'circle') {
      // Через AllExceptionsFilter → единый конверт с HTTP 400 (а не 200 + success:false,
      // который axios-обёртки и клиент не отличат от успеха).
      throw badRequest('finance.unknownPrincipal');
    }
    const data = await this.finances.removeShare(user.sub, principalType, principalId, bookId || undefined);
    return { success: true, data };
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'Books shared with me (for the switcher)' })
  async sharedWithMe(@CurrentUser() user: JwtPayload) {
    const data = await this.finances.listSharedWithMe(user.sub);
    return { success: true, data };
  }

  // ---------- debts (долги «я должен») ----------

  @Get('debts')
  @ApiOperation({ summary: 'My debts: instalments and loans (balance, progress, payment day)' })
  async listDebts(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listDebts(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('debts')
  @ApiOperation({ summary: 'Create a debt: an instalment purchase (full-amount expense) or a cash loan' })
  async createDebt(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = createFinDebtSchema.parse(body);
    const data = await this.finances.createDebt(user.sub, dto, bookId || undefined);
    return { success: true, data };
  }

  @Post('debts/:id/pay')
  @ApiOperation({ summary: 'One-tap "paid": a debt payment (the monthly one by default, never above the balance)' })
  async payDebt(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = payFinDebtSchema.parse(body);
    const data = await this.finances.payDebt(user.sub, id, dto, bookId || undefined);
    return { success: true, data };
  }

  @Patch('debts/:id')
  @ApiOperation({ summary: 'Update a debt (name / payment day / monthly payment)' })
  async updateDebt(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = updateFinDebtSchema.parse(body);
    const data = await this.finances.updateDebt(user.sub, id, dto, bookId || undefined);
    return { success: true, data };
  }

  // ---------- recurring (повторяющиеся операции) ----------

  @Get('recurring')
  @ApiOperation({ summary: 'Recurring transactions (templates: auto-record or reminder)' })
  async listRecurring(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listRecurring(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('recurring')
  @ApiOperation({ summary: 'Create a recurring rule (subscription / rent: monthly or weekly)' })
  async createRecurring(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = createFinRecurringSchema.parse(body);
    const data = await this.finances.createRecurring(user.sub, dto, bookId || undefined);
    return { success: true, data };
  }

  @Patch('recurring/:id')
  @ApiOperation({ summary: 'Update a recurring rule (amount / day / auto / pause)' })
  async updateRecurring(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = updateFinRecurringSchema.parse(body);
    const data = await this.finances.updateRecurring(user.sub, id, dto, bookId || undefined);
    return { success: true, data };
  }

  @Delete('recurring/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a recurring rule (the transaction history is untouched)' })
  async deleteRecurring(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.deleteRecurring(user.sub, id, bookId || undefined);
    return { success: true, data };
  }

  @Post('recurring/:id/record-now')
  @ApiOperation({ summary: '"Record now" — a transaction from the template dated today' })
  async recordRecurringNow(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.recordRecurringNow(user.sub, id, bookId || undefined);
    return { success: true, data };
  }

  // ---------- transactions ----------

  @Get('transactions')
  @ApiOperation({ summary: 'Transaction list: filters by date / account / category / person, cursor pagination' })
  async listTransactions(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const query = listFinTransactionsQuerySchema.parse(rawQuery);
    return { success: true, data: await this.finances.listTransactions(user.sub, query) };
  }

  @Post('transactions')
  @ApiOperation({ summary: 'Record a transaction: expense / income / transfer / exchange (double entry from→to)' })
  async createTransaction(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = createFinTransactionSchema.parse(body);
    const data = await this.finances.createTransaction(user.sub, dto, bookId || undefined);
    return { success: true, data };
  }

  @Patch('transactions/:id')
  @ApiOperation({ summary: 'Correct a transaction (the edit goes to the audit log)' })
  async updateTransaction(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('bookId') bookId?: string,
  ) {
    const dto = updateFinTransactionSchema.parse(body);
    const data = await this.finances.updateTransaction(user.sub, id, dto, bookId || undefined);
    return { success: true, data };
  }

  @Delete('transactions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a transaction (soft; the deletion goes to the audit log)' })
  async deleteTransaction(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.deleteTransaction(user.sub, id, bookId || undefined);
    return { success: true, data };
  }
}
