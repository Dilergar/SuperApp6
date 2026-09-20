import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import {
  createTaskSchema,
  updateTaskSchema,
  taskParticipantActionSchema,
  attachTaskFileSchema,
  type TaskFilter,
  type ViewerTaskRole,
  type TaskSmartList,
} from '@superapp/shared';

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private tasksService: TasksService) {}

  @Get()
  @ApiOperation({ summary: 'List tasks (smart filters, roles, pagination)' })
  async getTasks(
    @CurrentUser() user: JwtPayload,
    @Query('smartList') smartList?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('parentId') parentId?: string,
    @Query('search') search?: string,
    @Query('dueDateFrom') dueDateFrom?: string,
    @Query('dueDateTo') dueDateTo?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const filters: TaskFilter & { parentId?: string | null } = {
      smartList: smartList as TaskSmartList | undefined,
      role: role as ViewerTaskRole | undefined,
      status: status?.split(',') as TaskFilter['status'],
      priority: priority?.split(',') as TaskFilter['priority'],
      workspaceId: workspaceId === 'null' ? null : workspaceId,
      parentId: parentId === undefined ? undefined : parentId === 'null' ? null : parentId,
      search,
      dueDateFrom,
      dueDateTo,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    };
    // OffsetPage<Task> целиком в `data` (было `{ success, ...result }` — spread
    // расплющивал страницу на `data` + `meta`).
    return { success: true, data: await this.tasksService.getTasks(user.sub, filters) };
  }

  // Повтор = ВТОРАЯ задача: исполнителям уже ушло уведомление, а награда уже
  // заморожена в эскроу (монеты создателя). Ключ обязателен.
  @Idempotent({ required: true })
  @Post()
  @ApiOperation({ summary: 'Create a task (roles, group, due date, reward)' })
  async createTask(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createTaskSchema.parse(body);
    const task = await this.tasksService.createTask(user.sub, data);
    return { success: true, data: task };
  }

  // Статический сегмент обязан быть объявлен ДО @Get(':id') — иначе Nest отдаст
  // getTask('stats') → 404.
  @Get('stats')
  @ApiOperation({ summary: 'Smart-list counters (sidebar badges and the Overview)' })
  async getStats(@CurrentUser() user: JwtPayload) {
    const stats = await this.tasksService.getStats(user.sub);
    return { success: true, data: stats };
  }

  @Get(':id')
  @ApiOperation({ summary: 'A task with its participants, subtasks and progress' })
  async getTask(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const task = await this.tasksService.getTask(user.sub, id);
    return { success: true, data: task };
  }

  // ---- Вложения задачи (движок файлов) ----

  @Get(':id/attachments')
  @ApiOperation({ summary: 'Files attached to the task' })
  async listAttachments(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.tasksService.listAttachments(user.sub, id) };
  }

  @Post(':id/attachments')
  @ApiOperation({ summary: 'Attach a file to the task (the file is already uploaded by the engine)' })
  async attachFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const { fileId } = attachTaskFileSchema.parse(body);
    return { success: true, data: await this.tasksService.attachFile(user.sub, id, fileId) };
  }

  @Delete(':id/attachments/:fileId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detach a file from the task' })
  async removeAttachment(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('fileId') fileId: string) {
    await this.tasksService.removeAttachment(user.sub, id, fileId);
    return { success: true };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a task (fields and roles — assigner only)' })
  async updateTask(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data = updateTaskSchema.parse(body);
    const task = await this.tasksService.updateTask(user.sub, id, data);
    return { success: true, data: task };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a task (assigner only)' })
  async deleteTask(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.tasksService.deleteTask(user.sub, id);
    return { success: true };
  }

  // ---- Acceptance flow ----

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit your own work (assignee / co-assignee). A self-task closes right away' })
  async submit(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const task = await this.tasksService.submitWork(user.sub, id);
    return { success: true, data: task };
  }

  // Приёмка ВЫПЛАЧИВАЕТ награду из эскроу — это деньги, и повтор без ключа
  // остался бы «как получится».
  @Idempotent({ required: true })
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a participant’s work (assigner)' })
  async accept(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { participantUserId } = taskParticipantActionSchema.parse(body ?? {});
    const task = await this.tasksService.acceptWork(user.sub, id, participantUserId);
    return { success: true, data: task };
  }

  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return a participant’s work for rework (assigner)' })
  async returnWork(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { participantUserId } = taskParticipantActionSchema.parse(body ?? {});
    const task = await this.tasksService.returnWork(user.sub, id, participantUserId);
    return { success: true, data: task };
  }

  // Per-task chat moved to the messenger contextual chat (Phase 2):
  // GET /api/messenger/tasks/:taskId/chat.
}
