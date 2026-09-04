import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LegalEntitiesService } from './legal-entities.service';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  createBankAccountSchema,
  createLegalEntitySchema,
  queryBoolean,
  updateBankAccountSchema,
  updateLegalEntitySchema,
} from '@superapp/shared';

/**
 * Юрлица организации. Старые ручки `/workspaces/:id/requisites` продолжают работать —
 * они читают и правят ГОЛОВНОЕ юрлицо (совместимость напечатанных документов и веба).
 */
@ApiTags('Legal entities')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/legal-entities')
export class LegalEntitiesController {
  constructor(private legal: LegalEntitiesService) {}

  @Get()
  @ApiOperation({ summary: 'Юрлица организации (admin+)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query('archived') archived?: string,
  ) {
    const includeArchived = queryBoolean.optional().parse(archived) === true;
    const data = await this.legal.list(user.sub, workspaceId, includeArchived);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Добавить юрлицо (admin+)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createLegalEntitySchema.parse(body);
    const data = await this.legal.create(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Get('lite')
  @ApiOperation({ summary: 'Справочник юрлиц для выпадашек (вся команда)' })
  async listLite(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query('archived') archived?: string,
  ) {
    const includeArchived = queryBoolean.optional().parse(archived) === true;
    const data = await this.legal.listLiteForMember(user.sub, workspaceId, includeArchived);
    return { success: true, data };
  }

  @Get(':leId')
  @ApiOperation({ summary: 'Юрлицо + счета (admin+)' })
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
  ) {
    const data = await this.legal.getOne(user.sub, workspaceId, leId);
    return { success: true, data };
  }

  @Patch(':leId')
  @ApiOperation({ summary: 'Изменить юрлицо (admin+; null очищает поле)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
    @Body() body: unknown,
  ) {
    const dto = updateLegalEntitySchema.parse(body);
    const data = await this.legal.update(user.sub, workspaceId, leId, dto);
    return { success: true, data };
  }

  @Post(':leId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'В архив (головное — 409)' })
  async archive(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
  ) {
    const data = await this.legal.archive(user.sub, workspaceId, leId);
    return { success: true, data };
  }

  @Post(':leId/make-head')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Сделать юрлицо головным (снимает флаг у прежнего)' })
  async makeHead(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
  ) {
    const data = await this.legal.makeHead(user.sub, workspaceId, leId);
    return { success: true, data };
  }

  @Post(':leId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вернуть из архива' })
  async restore(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
  ) {
    const data = await this.legal.restore(user.sub, workspaceId, leId);
    return { success: true, data };
  }

  @Post(':leId/accounts')
  @ApiOperation({ summary: 'Добавить счёт юрлица (первый становится основным)' })
  async addAccount(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
    @Body() body: unknown,
  ) {
    const dto = createBankAccountSchema.parse(body);
    const data = await this.legal.addBankAccount(user.sub, workspaceId, leId, dto);
    return { success: true, data };
  }

  @Patch(':leId/accounts/:accId')
  @ApiOperation({ summary: 'Изменить счёт / назначить основным' })
  async updateAccount(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
    @Param('accId') accId: string,
    @Body() body: unknown,
  ) {
    const dto = updateBankAccountSchema.parse(body);
    const data = await this.legal.updateBankAccount(user.sub, workspaceId, leId, accId, dto);
    return { success: true, data };
  }

  @Delete(':leId/accounts/:accId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить счёт' })
  async removeAccount(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
    @Param('accId') accId: string,
  ) {
    const data = await this.legal.removeBankAccount(user.sub, workspaceId, leId, accId);
    return { success: true, data };
  }
}
