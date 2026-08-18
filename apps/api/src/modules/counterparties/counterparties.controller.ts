import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createCounterpartyBankAccountSchema,
  createCounterpartyContactSchema,
  createCounterpartySchema,
  isValidIinOrBin,
  listCounterpartiesSchema,
  updateCounterpartyContactSchema,
  updateCounterpartySchema,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { CounterpartiesService } from './counterparties.service';

/**
 * Сервис «Контрагенты» — тонкий контроллер: Zod-разбор → сервис (AI-ready,
 * Принцип 4). Путь скоупится организацией (паттерн Staff/Documents).
 */
@ApiTags('counterparties')
@Controller('workspaces/:workspaceId/counterparties')
export class CounterpartiesController {
  constructor(private readonly counterparties: CounterpartiesService) {}

  // ВАЖНО: статический путь ДО ':counterpartyId' — иначе Nest ищет контрагента
  // с идентификатором «lookup» (та же ловушка, что в approvals и share-links).
  @Get('lookup')
  @ApiOperation({ summary: 'Найти живого контрагента по БИН/ИИН (дедуп в форме)' })
  async lookup(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query('bin') bin: string,
  ) {
    if (!bin || !isValidIinOrBin(bin.trim())) {
      throw new BadRequestException('БИН/ИИН — 12 цифр с контрольной суммой');
    }
    const data = await this.counterparties.lookup(user.sub, workspaceId, bin.trim());
    return { success: true, data };
  }

  @Get()
  @ApiOperation({ summary: 'Справочник контрагентов (поиск, вид, архив; keyset)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const dto = listCounterpartiesSchema.parse(query);
    const data = await this.counterparties.list(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Добавить контрагента (Менеджер+)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createCounterpartySchema.parse(body);
    const data = await this.counterparties.create(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Get(':counterpartyId')
  @ApiOperation({ summary: 'Карточка контрагента' })
  async get(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
  ) {
    const data = await this.counterparties.get(user.sub, workspaceId, counterpartyId);
    return { success: true, data };
  }

  @Patch(':counterpartyId')
  @ApiOperation({ summary: 'Изменить карточку (Менеджер+)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Body() body: unknown,
  ) {
    const dto = updateCounterpartySchema.parse(body);
    const data = await this.counterparties.update(user.sub, workspaceId, counterpartyId, dto);
    return { success: true, data };
  }

  @Delete(':counterpartyId')
  @ApiOperation({ summary: 'Убрать в архив (Менеджер+; документы в работе блокируют)' })
  async archive(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
  ) {
    await this.counterparties.archive(user.sub, workspaceId, counterpartyId);
    return { success: true, data: { archived: true } };
  }

  @Post(':counterpartyId/restore')
  @ApiOperation({ summary: 'Вернуть из архива (Менеджер+; занятый БИН/ИИН → 409)' })
  async restore(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
  ) {
    const data = await this.counterparties.restore(user.sub, workspaceId, counterpartyId);
    return { success: true, data };
  }

  // ---- Контактные лица ----

  @Post(':counterpartyId/contacts')
  @ApiOperation({ summary: 'Добавить контактное лицо (Менеджер+)' })
  async addContact(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Body() body: unknown,
  ) {
    const dto = createCounterpartyContactSchema.parse(body);
    const data = await this.counterparties.addContact(user.sub, workspaceId, counterpartyId, dto);
    return { success: true, data };
  }

  @Patch(':counterpartyId/contacts/:contactId')
  @ApiOperation({ summary: 'Изменить контактное лицо (Менеджер+)' })
  async updateContact(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
  ) {
    const dto = updateCounterpartyContactSchema.parse(body);
    const data = await this.counterparties.updateContact(user.sub, workspaceId, counterpartyId, contactId, dto);
    return { success: true, data };
  }

  @Delete(':counterpartyId/contacts/:contactId')
  @ApiOperation({ summary: 'Убрать контактное лицо (в архив: на него ссылаются документы)' })
  async removeContact(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Param('contactId') contactId: string,
  ) {
    await this.counterparties.removeContact(user.sub, workspaceId, counterpartyId, contactId);
    return { success: true, data: { removed: true } };
  }

  // ---- Банковские счета ----

  @Post(':counterpartyId/accounts')
  @ApiOperation({ summary: 'Добавить счёт (первый — основной сам; Менеджер+)' })
  async addAccount(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Body() body: unknown,
  ) {
    const dto = createCounterpartyBankAccountSchema.parse(body);
    const data = await this.counterparties.addBankAccount(user.sub, workspaceId, counterpartyId, dto);
    return { success: true, data };
  }

  @Post(':counterpartyId/accounts/:accountId/set-primary')
  @ApiOperation({ summary: 'Сделать счёт основным (Менеджер+)' })
  async setPrimary(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Param('accountId') accountId: string,
  ) {
    await this.counterparties.setPrimaryBankAccount(user.sub, workspaceId, counterpartyId, accountId);
    return { success: true, data: { primary: true } };
  }

  @Delete(':counterpartyId/accounts/:accountId')
  @ApiOperation({ summary: 'Удалить счёт (основной передаёт роль старейшему)' })
  async removeAccount(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Param('accountId') accountId: string,
  ) {
    await this.counterparties.removeBankAccount(user.sub, workspaceId, counterpartyId, accountId);
    return { success: true, data: { removed: true } };
  }
}
