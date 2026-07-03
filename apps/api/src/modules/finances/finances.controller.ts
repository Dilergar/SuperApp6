import {
  Controller, Get, Post, Patch, Put, Delete,
  Body, Param, Query, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
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
  @ApiOperation({ summary: 'Обзор книги: счета с балансами + дерево категорий (лениво создаёт книгу)' })
  async getOverview(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.getOverview(user.sub, bookId || undefined);
    return { success: true, data };
  }

  // ---------- accounts ----------

  @Post('accounts')
  @ApiOperation({ summary: 'Создать счёт (наличные/карта/депозит) с необязательным начальным остатком' })
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
  @ApiOperation({ summary: '«У меня сейчас на счёте N» — корректировка остатка (двойная запись через Начальный остаток)' })
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
  @ApiOperation({ summary: 'Обновить счёт (имя/иконка/архив/порядок)' })
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
  @ApiOperation({ summary: 'Удалить счёт (с историей — архивируется)' })
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
  @ApiOperation({ summary: 'Создать категорию расходов/доходов (дерево до 2 уровней)' })
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
  @ApiOperation({ summary: 'Обновить категорию (имя/иконка/архив/родитель)' })
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
  @ApiOperation({ summary: 'Удалить категорию (с историей — архивируется; с подкатегориями — 409)' })
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
  @ApiOperation({ summary: 'Задать/обновить лимит категории на месяц (amount=null — удалить)' })
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
  @ApiOperation({ summary: 'Отчёт месяца: категории (факт), доходы, платежи по долгам, лимиты план-факт' })
  async monthReport(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finMonthReportQuerySchema.parse(rawQuery);
    const data = await this.finances.getMonthReport(user.sub, q.period, q.bookId);
    return { success: true, data };
  }

  @Get('reports/trend')
  @ApiOperation({ summary: 'Динамика по месяцам: расходы/доходы (по валютам)' })
  async trend(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finTrendQuerySchema.parse(rawQuery);
    const data = await this.finances.getTrend(user.sub, q.months ?? 6, q.bookId);
    return { success: true, data };
  }

  // ---------- people («Близкие» + отчёт по людям) ----------

  @Get('people')
  @ApiOperation({ summary: '«Близкие» — быстрый список для поля «на кого»' })
  async listPeople(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listPeople(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('people')
  @ApiOperation({ summary: 'Добавить человека из окружения в «Близкие»' })
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
  @ApiOperation({ summary: 'Убрать человека из «Близких» (история операций не трогается)' })
  async removePerson(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.removePerson(user.sub, userId, bookId || undefined);
    return { success: true, data };
  }

  @Get('reports/people')
  @ApiOperation({ summary: 'Отчёт «по людям»: сколько потратил на / получил от каждого' })
  async peopleReport(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finPeopleReportQuerySchema.parse(rawQuery);
    const data = await this.finances.getPeopleReport(user.sub, q, q.bookId);
    return { success: true, data };
  }

  // ---------- coins: авто-лента экосистемы (проекция кошелька, только своя) ----------

  @Get('coins')
  @ApiOperation({ summary: 'Коин-лента экосистемы: награды задач, покупки, казна — из леджера, с контекстом' })
  async coinFeed(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const q = finCoinFeedQuerySchema.parse(rawQuery);
    const { items, nextCursor } = await this.finances.getCoinFeed(user.sub, q.cursor, q.limit ?? 30);
    return { success: true, data: items, nextCursor };
  }

  // ---------- shares (семейный доступ) ----------

  @Get('shares')
  @ApiOperation({ summary: 'Кому открыта моя книга (люди и Группы, роли «смотрит»/«ведёт»)' })
  async listShares(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listShares(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('shares')
  @ApiOperation({ summary: 'Дать доступ к книге человеку из окружения или своей Группе' })
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
  @ApiOperation({ summary: 'Отозвать доступ' })
  async removeShare(
    @CurrentUser() user: JwtPayload,
    @Param('principalType') principalType: string,
    @Param('principalId') principalId: string,
    @Query('bookId') bookId?: string,
  ) {
    if (principalType !== 'user' && principalType !== 'circle') {
      // Через AllExceptionsFilter → единый конверт с HTTP 400 (а не 200 + success:false,
      // который axios-обёртки и клиент не отличат от успеха).
      throw new BadRequestException('Неизвестный тип принципала');
    }
    const data = await this.finances.removeShare(user.sub, principalType, principalId, bookId || undefined);
    return { success: true, data };
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'Книги, которыми со мной поделились (для переключателя)' })
  async sharedWithMe(@CurrentUser() user: JwtPayload) {
    const data = await this.finances.listSharedWithMe(user.sub);
    return { success: true, data };
  }

  // ---------- debts (долги «я должен») ----------

  @Get('debts')
  @ApiOperation({ summary: 'Мои долги: рассрочки и кредиты (остаток, прогресс, день платежа)' })
  async listDebts(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listDebts(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('debts')
  @ApiOperation({ summary: 'Создать долг: рассрочка-покупка (расход полной суммой) или кредит деньгами' })
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
  @ApiOperation({ summary: '«Оплачено» в 1 тап: платёж по долгу (по умолчанию — ежемесячный, не больше остатка)' })
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
  @ApiOperation({ summary: 'Обновить долг (имя / день платежа / ежемесячный платёж)' })
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
  @ApiOperation({ summary: 'Повторяющиеся операции (шаблоны: авто-запись или напоминание)' })
  async listRecurring(@CurrentUser() user: JwtPayload, @Query('bookId') bookId?: string) {
    const data = await this.finances.listRecurring(user.sub, bookId || undefined);
    return { success: true, data };
  }

  @Post('recurring')
  @ApiOperation({ summary: 'Создать повтор (подписка/аренда: месяц или неделя)' })
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
  @ApiOperation({ summary: 'Обновить повтор (сумма/день/авто/пауза)' })
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
  @ApiOperation({ summary: 'Удалить повтор (история операций не трогается)' })
  async deleteRecurring(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.deleteRecurring(user.sub, id, bookId || undefined);
    return { success: true, data };
  }

  @Post('recurring/:id/record-now')
  @ApiOperation({ summary: '«Записать сейчас» — операция по шаблону сегодняшним днём' })
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
  @ApiOperation({ summary: 'Список операций: фильтры по датам/счёту/категории/человеку, курсорная пагинация' })
  async listTransactions(@CurrentUser() user: JwtPayload, @Query() rawQuery: Record<string, unknown>) {
    const query = listFinTransactionsQuerySchema.parse(rawQuery);
    const data = await this.finances.listTransactions(user.sub, query);
    return { success: true, data: data.items, nextCursor: data.nextCursor };
  }

  @Post('transactions')
  @ApiOperation({ summary: 'Записать операцию: расход / доход / перевод / обмен (двойная запись from→to)' })
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
  @ApiOperation({ summary: 'Исправить операцию (правка пишется в аудит-журнал)' })
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
  @ApiOperation({ summary: 'Удалить операцию (мягко; удаление в аудит-журнале)' })
  async deleteTransaction(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('bookId') bookId?: string,
  ) {
    const data = await this.finances.deleteTransaction(user.sub, id, bookId || undefined);
    return { success: true, data };
  }
}
