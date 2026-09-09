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
import { z } from 'zod';
import {
  PROCESS_SURFACES,
  createProcessCredentialSchema,
  createProcessDefinitionSchema,
  decideApprovalSchema,
  publishProcessSchema,
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
  @ApiOperation({ summary: 'The processes of the organization (the team; admins-only processes need admin+)' })
  async list(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.processes.listDefinitions(user.sub, id);
    return { success: true, data };
  }

  @Get('node-types')
  @ApiOperation({ summary: 'The node palette (type descriptors; ?surface= trims it to a domain)' })
  async nodeTypes(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('surface') surface?: string,
  ) {
    // Профиль сужен до реестра: опечатка в `?surface=` раньше молча отдавала полную
    // палитру (32 ноды вместо 11 кадровых).
    const parsed = surface ? z.enum(PROCESS_SURFACES).parse(surface) : undefined;
    const data = await this.processes.listNodeTypes(user.sub, id, parsed);
    return { success: true, data };
  }

  @Get('inbox')
  @ApiOperation({ summary: 'Inbox: the queued tasks of my departments (decisions live in the shared decision stack)' })
  async inbox(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.processes.listInbox(user.sub, id);
    return { success: true, data };
  }

  // ----- Ф3: сейф кредов (manager+) -----

  @Get('credentials')
  @ApiOperation({ summary: 'The credentials of the organization for HTTP nodes (without the secrets; manager+)' })
  async listCredentials(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.processes.listCredentials(user.sub, id);
    return { success: true, data };
  }

  @Post('credentials')
  @ApiOperation({ summary: 'Add a credential to the safe (the secret is encrypted; manager+)' })
  async createCredential(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const data = createProcessCredentialSchema.parse(body);
    const res = await this.processes.createCredential(user.sub, id, data);
    return { success: true, data: res };
  }

  @Delete('credentials/:credId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a credential (manager+)' })
  async deleteCredential(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('credId') credId: string) {
    await this.processes.deleteCredential(user.sub, id, credId);
    return { success: true };
  }

  @Get('instances')
  @ApiOperation({ summary: 'The log of started processes (manager+ sees all, the rest see their own)' })
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
  @ApiOperation({ summary: 'A started process: the steps, the timing and the canvas of the pinned version' })
  async getInstance(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
  ) {
    const data = await this.processes.getInstance(user.sub, id, instId);
    return { success: true, data };
  }

  @Get('instances/:instId/status')
  @ApiOperation({ summary: 'A thin instance status (P7): step statuses without the document or the form — for polling' })
  async getInstanceStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
  ) {
    const data = await this.processes.getInstanceStatus(user.sub, id, instId);
    return { success: true, data };
  }

  @Post('instances/:instId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a process (the initiator or manager+); the open tasks are cancelled' })
  async cancelInstance(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
  ) {
    await this.processes.cancelInstance(user.sub, id, instId);
    return { success: true };
  }

  @Post('instances/:instId/steps/:stepId/claim')
  @ApiOperation({ summary: 'Take a department task from the queue (a member of the department) — a task is created' })
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
  @ApiOperation({ summary: 'A decision on a step: approved | rejected | returned (the reason is mandatory for the last two)' })
  async decideStep(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('instId') instId: string,
    @Param('stepId') stepId: string,
    @Body() body: unknown,
  ) {
    const { decision, comment } = decideApprovalSchema.parse(body);
    await this.processes.decideStep(user.sub, id, instId, stepId, decision, comment);
    return { success: true };
  }

  @Post('instances/:instId/steps/:stepId/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reassign the step to another employee (manager+)' })
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
  @ApiOperation({ summary: 'Create a process (manager+; a draft start-to-end is created)' })
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
  @ApiOperation({ summary: 'A process: the document of the latest version plus a soft validation' })
  async get(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
  ) {
    const data = await this.processes.getDefinition(user.sub, id, defId);
    return { success: true, data };
  }

  @Patch(':defId')
  @ApiOperation({ summary: 'Update the process meta: the name, the description and the visibility (manager+)' })
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
  @ApiOperation({ summary: 'Save the canvas document (manager+; editing a published one starts a new draft)' })
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
  @ApiOperation({ summary: 'The report of the time spent by steps and departments (manager+)' })
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
  @ApiOperation({ summary: 'Validate the document (the compilation plus the membership of the assignees)' })
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
  @ApiOperation({ summary: 'Publish the draft (manager+; one version is active, the running instances stay on theirs)' })
  async publish(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
    @Body() body?: unknown,
  ) {
    // acceptWarnings — поимённое «Понимаю, публикую» по правилам предметной области.
    // Пустой список = публикация только чистого маршрута; так ведёт себя и старый
    // клиент, не знающий про предупреждения (fail-closed).
    const { acceptWarnings } = publishProcessSchema.parse(body ?? {});
    const data = await this.processes.publish(user.sub, id, defId, acceptWarnings);
    return { success: true, data };
  }

  @Delete(':defId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a process (manager+; running instances block it)' })
  async archive(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('defId') defId: string,
  ) {
    await this.processes.archiveDefinition(user.sub, id, defId);
    return { success: true };
  }

  @Post(':defId/start')
  @ApiOperation({ summary: 'Start a process (the team; the form is validated against the version form)' })
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
