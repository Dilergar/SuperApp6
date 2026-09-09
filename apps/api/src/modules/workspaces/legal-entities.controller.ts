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
  @ApiOperation({ summary: 'The legal entities of the organization (admin+)' })
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
  @ApiOperation({ summary: 'Add a legal entity (admin+)' })
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
  @ApiOperation({ summary: 'The list of legal entities for pickers (the whole team)' })
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
  @ApiOperation({ summary: 'A legal entity + its accounts (admin+)' })
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
  ) {
    const data = await this.legal.getOne(user.sub, workspaceId, leId);
    return { success: true, data };
  }

  @Patch(':leId')
  @ApiOperation({ summary: 'Change a legal entity (admin+; null clears a field)' })
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
  @ApiOperation({ summary: 'Send to the archive (the head one — 409)' })
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
  @ApiOperation({ summary: 'Make the legal entity the head one (clears the flag on the previous one)' })
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
  @ApiOperation({ summary: 'Restore from the archive' })
  async restore(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('leId') leId: string,
  ) {
    const data = await this.legal.restore(user.sub, workspaceId, leId);
    return { success: true, data };
  }

  @Post(':leId/accounts')
  @ApiOperation({ summary: 'Add a bank account of the legal entity (the first one becomes the main one)' })
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
  @ApiOperation({ summary: 'Change an account / make it the main one' })
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
  @ApiOperation({ summary: 'Delete an account' })
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
