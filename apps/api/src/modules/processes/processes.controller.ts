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
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createProcessCredentialSchema,
  createProcessDefinitionSchema,
  decideApprovalSchema,
  reassignStepSchema,
  saveProcessDocumentSchema,
  startProcessSchema,
  updateProcessDefinitionSchema,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ProcessesService } from './processes.service';

/**
 * Сервис «Процессы» (B2B): конструктор + журнал запущенных.
 * Тонкие хендлеры (Zod → сервис) — каждая операция вызываема программно (AI-ready).
 * ВАЖНО: конкретные пути (node-types, instances) объявлены ДО ':defId'.
 */
@ApiTags('Processes')
@ApiBearerAuth()
@Controller('workspaces/:id/processes')
export class ProcessesController {
  constructor(private processes: ProcessesService) {}

  @Get()
  @ApiOperation({ summary: 'Процессы организации (команда; admins-процессы — admin+)' })
  async list(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.processes.listDefinitions(user.sub, id);
    return { success: true, data };
  }

  @Get('node-types')
  @ApiOperation({ summary: 'Палитра нод (паспорта типов; system-ноды — платформенной роли)' })
  async nodeTypes(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.processes.listNodeTypes(user.sub, id);
    return { success: true, data };
  }

  @Get('inbox')
  @ApiOperation({ summary: 'Входящие: задачи моих отделов в очереди (забрать) + одобрения на мне' })
  async inbox(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.processes.listInbox(user.sub, id);
    return { success: true, data };
  }

  // ----- Ф3: сейф кредов (manager+) -----

  @Get('credentials')
  @ApiOperation({ summary: 'Креды организации для HTTP-нод (без секретов; manager+)' })
  async listCredentials(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.processes.listCredentials(user.sub, id);
    return { success: true, data };
  }

  @Post('credentials')
  @ApiOperation({ summary: 'Добавить креды в сейф (секрет шифруется; manager+)' })
  async createCredential(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const data = createProcessCredentialSchema.parse(body);
    const res = await this.processes.createCredential(user.sub, id, data);
    return { success: true, data: res };
  }

  @Delete('credentials/:credId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить креды (manager+)' })
  async deleteCredential(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('credId') credId: string) {
    await this.processes.deleteCredential(user.sub, id, credId);
    return { success: true };
  }

  @Get('instances')
  @ApiOperation({ summary: 'Журнал запущенных процессов (manager+ — все; остальные — свои)' })
  async listInstances(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('definitionId') definitionId?: string,
    @Query('status') status?: string,
  ) {
    const data = await this.processes.listInstances(user.sub, id, { definitionId, status });
    return { success: true, data };
  }

  @Get('instances/:instId')
  @ApiOperation({ summary: 'Запущенный процесс: шаги, тайминг, канвас закреплённой версии' })
  async getInstance(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
  ) {
    const data = await this.processes.getInstance(user.sub, id, instId);
    return { success: true, data };
  }

  @Post('instances/:instId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить процесс (инициатор или manager+); открытые задачи отменяются' })
  async cancelInstance(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
  ) {
    await this.processes.cancelInstance(user.sub, id, instId);
    return { success: true };
  }

  @Post('instances/:instId/steps/:stepId/claim')
  @ApiOperation({ summary: 'Забрать задачу отдела из очереди (член отдела) → создаётся задача' })
  async claimStep(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
    @Param('stepId') stepId: string,
  ) {
    const data = await this.processes.claimStep(user.sub, id, instId, stepId);
    return { success: true, data };
  }

  @Post('instances/:instId/steps/:stepId/decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Решение по одобрению: approved | rejected (назначенный согласующий)' })
  async decideStep(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
    @Param('stepId') stepId: string,
    @Body() body: unknown,
  ) {
    const { decision } = decideApprovalSchema.parse(body);
    await this.processes.decideStep(user.sub, id, instId, stepId, decision);
    return { success: true };
  }

  @Post('instances/:instId/steps/:stepId/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Переназначить исполнителя шага на другого сотрудника (manager+)' })
  async reassignStep(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
    @Param('stepId') stepId: string,
    @Body() body: unknown,
  ) {
    const { userId } = reassignStepSchema.parse(body);
    await this.processes.reassignStep(user.sub, id, instId, stepId, userId);
    return { success: true };
  }

  @Post()
  @ApiOperation({ summary: 'Создать процесс (manager+; создаётся черновик Старт→Конец)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = createProcessDefinitionSchema.parse(body);
    const def = await this.processes.createDefinition(user.sub, id, data);
    return { success: true, data: def };
  }

  @Get(':defId')
  @ApiOperation({ summary: 'Процесс: документ последней версии + мягкая валидация' })
  async get(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
  ) {
    const data = await this.processes.getDefinition(user.sub, id, defId);
    return { success: true, data };
  }

  @Patch(':defId')
  @ApiOperation({ summary: 'Обновить мета процесса: имя/описание/видимость (manager+)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
    @Body() body: unknown,
  ) {
    const data = updateProcessDefinitionSchema.parse(body);
    await this.processes.updateDefinition(user.sub, id, defId, data);
    return { success: true };
  }

  @Put(':defId/document')
  @ApiOperation({ summary: 'Сохранить документ канваса (manager+; правка published → новый черновик)' })
  async saveDocument(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
    @Body() body: unknown,
  ) {
    const { document } = saveProcessDocumentSchema.parse(body);
    const data = await this.processes.saveDocument(user.sub, id, defId, document);
    return { success: true, data };
  }

  @Get(':defId/report')
  @ApiOperation({ summary: 'Отчёт «время по шагам/отделам» (manager+)' })
  async report(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
  ) {
    const data = await this.processes.getReport(user.sub, id, defId);
    return { success: true, data };
  }

  @Post(':defId/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Проверить документ (компиляция + членство исполнителей)' })
  async validate(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
  ) {
    const data = await this.processes.validateDefinition(user.sub, id, defId);
    return { success: true, data };
  }

  @Post(':defId/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Опубликовать черновик (manager+; активна одна версия, инстансы доживают на своих)' })
  async publish(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
  ) {
    const data = await this.processes.publish(user.sub, id, defId);
    return { success: true, data };
  }

  @Delete(':defId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Архивировать процесс (manager+; запущенные инстансы блокируют)' })
  async archive(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
  ) {
    await this.processes.archiveDefinition(user.sub, id, defId);
    return { success: true };
  }

  @Post(':defId/start')
  @ApiOperation({ summary: 'Запустить процесс (команда; анкета валидируется по форме версии)' })
  async start(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
    @Body() body: unknown,
  ) {
    const { input } = startProcessSchema.parse(body);
    const data = await this.processes.startInstance(user.sub, id, defId, input);
    return { success: true, data };
  }
}
