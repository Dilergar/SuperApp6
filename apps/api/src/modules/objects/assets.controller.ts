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
  @ApiOperation({ summary: 'Модели оборудования организации' })
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
  @ApiOperation({ summary: 'Добавить модель' })
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
  @ApiOperation({ summary: 'Изменить модель' })
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
  @ApiOperation({ summary: 'Удалить модель (есть экземпляры — 409)' })
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
  @ApiOperation({ summary: 'Файлы модели: инструкция, паспорт' })
  async modelFiles(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('modelId') modelId: string,
  ) {
    const data = await this.assets.listModelFiles(user.sub, workspaceId, modelId);
    return { success: true, data };
  }

  @Post('asset-models/:modelId/files')
  @ApiOperation({ summary: 'Приложить файл к модели' })
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
  @ApiOperation({ summary: 'Отвязать файл модели' })
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
  @ApiOperation({ summary: 'Оборудование объекта (курсорная страница)' })
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
  @ApiOperation({ summary: 'Добавить оборудование (модель можно создать на лету)' })
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
  @ApiOperation({ summary: 'Карточка: данные + журналы' })
  async card(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
  ) {
    const data = await this.assets.card(user.sub, workspaceId, assetId);
    return { success: true, data };
  }

  @Patch('assets/:assetId')
  @ApiOperation({ summary: 'Изменить карточку' })
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
  @ApiOperation({ summary: 'Переместить (пишет журнал в той же транзакции)' })
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
  @ApiOperation({ summary: 'Сменить ответственного (запись журнала)' })
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
  @ApiOperation({ summary: 'Владение и баланс (нужно право на деньги объекта)' })
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
  @ApiOperation({ summary: 'Состояние: в работе / ремонт / списано' })
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
  @ApiOperation({ summary: 'Записать обслуживание/ремонт' })
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
  @ApiOperation({ summary: 'Изменить запись обслуживания' })
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
  @ApiOperation({ summary: 'Фото и документы оборудования' })
  async files(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
  ) {
    const data = await this.assets.listFiles(user.sub, workspaceId, assetId);
    return { success: true, data };
  }

  @Post('assets/:assetId/files')
  @ApiOperation({ summary: 'Приложить файл' })
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
  @ApiOperation({ summary: 'Отвязать файл' })
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
