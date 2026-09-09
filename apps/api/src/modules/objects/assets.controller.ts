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
import { z } from 'zod';
import {
  assetModelSchema,
  assetModelsQuerySchema,
  assetServiceSchema,
  assetsQuerySchema,
  createAssetSchema,
  moveAssetSchema,
  setAssetCustodianSchema,
  setAssetHoldingSchema,
  setAssetStatusSchema,
  updateAssetModelSchema,
  updateAssetSchema,
  updateAssetServiceSchema,
} from '@superapp/shared';
import { AssetsService } from './assets.service';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';

const attachFileSchema = z.object({ fileId: z.string().uuid() }).strict();

/** Оборудование объекта: справочник моделей, экземпляры, журналы. */
@ApiTags('Objects · assets')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId')
export class AssetsController {
  constructor(private assets: AssetsService) {}

  // ---- Справочник моделей ----

  @Get('asset-models')
  @ApiOperation({ summary: 'Equipment models of the organization' })
  async models(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query() query: unknown,
  ) {
    const q = assetModelsQuerySchema.parse(query ?? {});
    const data = await this.assets.listModels(user.sub, workspaceId, q);
    return { success: true, data };
  }

  @Post('asset-models')
  @ApiOperation({ summary: 'Add a model' })
  async createModel(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = assetModelSchema.parse(body);
    const data = await this.assets.createModel(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Patch('asset-models/:modelId')
  @ApiOperation({ summary: 'Change a model' })
  async updateModel(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('modelId') modelId: string,
    @Body() body: unknown,
  ) {
    const dto = updateAssetModelSchema.parse(body);
    const data = await this.assets.updateModel(user.sub, workspaceId, modelId, dto);
    return { success: true, data };
  }

  @Delete('asset-models/:modelId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a model (there are items — 409)' })
  async removeModel(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('modelId') modelId: string,
  ) {
    await this.assets.removeModel(user.sub, workspaceId, modelId);
    return { success: true, data: { ok: true } };
  }

  // Инструкция и паспорт крепятся к МОДЕЛИ один раз — на все двадцать одинаковых
  // кофемашин сети (обещание канона: docs/objects_assets.md). Статические пути
  // объявлены после `asset-models/:modelId`, но с собственным сегментом `files`.
  @Get('asset-models/:modelId/files')
  @ApiOperation({ summary: 'Files of a model: a manual, a data sheet' })
  async modelFiles(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('modelId') modelId: string,
  ) {
    const data = await this.assets.listModelFiles(user.sub, workspaceId, modelId);
    return { success: true, data };
  }

  @Post('asset-models/:modelId/files')
  @ApiOperation({ summary: 'Attach a file to a model' })
  async attachModelFile(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('modelId') modelId: string,
    @Body() body: unknown,
  ) {
    const { fileId } = attachFileSchema.parse(body);
    await this.assets.attachModelFile(user.sub, workspaceId, modelId, fileId);
    return { success: true, data: { ok: true } };
  }

  @Delete('asset-models/:modelId/files/:fileId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detach a file from a model' })
  async detachModelFile(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('modelId') modelId: string,
    @Param('fileId') fileId: string,
  ) {
    await this.assets.detachModelFile(user.sub, workspaceId, modelId, fileId);
    return { success: true, data: { ok: true } };
  }

  // ---- Экземпляры ----

  @Get('objects/:objectId/assets')
  @ApiOperation({ summary: 'Equipment of the site (a cursor page)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Query() query: unknown,
  ) {
    const q = assetsQuerySchema.parse(query ?? {});
    const data = await this.assets.list(user.sub, workspaceId, objectId, q);
    return { success: true, data };
  }

  @Post('objects/:objectId/assets')
  @ApiOperation({ summary: 'Add a piece of equipment (a model can be created on the fly)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = createAssetSchema.parse(body);
    const data = await this.assets.create(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Get('assets/:assetId')
  @ApiOperation({ summary: 'The card: data + the logs' })
  async card(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
  ) {
    const data = await this.assets.card(user.sub, workspaceId, assetId);
    return { success: true, data };
  }

  @Patch('assets/:assetId')
  @ApiOperation({ summary: 'Change the card' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const dto = updateAssetSchema.parse(body);
    const data = await this.assets.update(user.sub, workspaceId, assetId, dto);
    return { success: true, data };
  }

  @Post('assets/:assetId/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move it (writes the log in the same transaction)' })
  async move(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const dto = moveAssetSchema.parse(body);
    const data = await this.assets.move(user.sub, workspaceId, assetId, dto);
    return { success: true, data };
  }

  @Post('assets/:assetId/custodian')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the person in charge (a log record)' })
  async custodian(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const dto = setAssetCustodianSchema.parse(body);
    const data = await this.assets.setCustodian(user.sub, workspaceId, assetId, dto);
    return { success: true, data };
  }

  @Post('assets/:assetId/holding')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ownership and the balance (the right to the money of the site is needed)' })
  async holding(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const dto = setAssetHoldingSchema.parse(body);
    const data = await this.assets.setHolding(user.sub, workspaceId, assetId, dto);
    return { success: true, data };
  }

  @Post('assets/:assetId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The condition: in service / under repair / written off' })
  async status(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const dto = setAssetStatusSchema.parse(body);
    const data = await this.assets.setStatus(user.sub, workspaceId, assetId, dto);
    return { success: true, data };
  }

  @Post('assets/:assetId/service')
  @ApiOperation({ summary: 'Log maintenance or a repair' })
  async logService(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const dto = assetServiceSchema.parse(body);
    const data = await this.assets.logService(user.sub, workspaceId, assetId, dto);
    return { success: true, data };
  }

  @Patch('assets/:assetId/service/:recId')
  @ApiOperation({ summary: 'Change a maintenance record' })
  async updateService(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Param('recId') recId: string,
    @Body() body: unknown,
  ) {
    const dto = updateAssetServiceSchema.parse(body);
    const data = await this.assets.updateService(user.sub, workspaceId, assetId, recId, dto);
    return { success: true, data };
  }

  @Get('assets/:assetId/files')
  @ApiOperation({ summary: 'Photos and documents of a piece of equipment' })
  async files(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
  ) {
    const data = await this.assets.listFiles(user.sub, workspaceId, assetId);
    return { success: true, data };
  }

  @Post('assets/:assetId/files')
  @ApiOperation({ summary: 'Attach a file' })
  async attach(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const { fileId } = attachFileSchema.parse(body);
    await this.assets.attachFile(user.sub, workspaceId, assetId, fileId);
    return { success: true, data: { ok: true } };
  }

  @Delete('assets/:assetId/files/:fileId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detach a file' })
  async detach(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Param('fileId') fileId: string,
  ) {
    await this.assets.detachFile(user.sub, workspaceId, assetId, fileId);
    return { success: true, data: { ok: true } };
  }
}
