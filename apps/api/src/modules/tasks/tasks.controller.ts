import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  createTaskSchema,
  updateTaskSchema,
  addTaskCommentSchema,
  taskParticipantActionSchema,
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
  @ApiOperation({ summary: 'Список задач (смарт-фильтры, роли, пагинация)' })
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
    const result = await this.tasksService.getTasks(user.sub, filters);
    return { success: true, ...result };
  }

  @Post()
  @ApiOperation({ summary: 'Создать задачу (роли, группа, дедлайн, награда)' })
  async createTask(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createTaskSchema.parse(body);
    const task = await this.tasksService.createTask(user.sub, data);
    return { success: true, data: task };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Задача с участниками, подзадачами и прогрессом' })
  async getTask(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const task = await this.tasksService.getTask(user.sub, id);
    return { success: true, data: task };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Обновить задачу (поля, роли — только Постановщик)' })
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
  @ApiOperation({ summary: 'Удалить задачу (только Постановщик)' })
  async deleteTask(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.tasksService.deleteTask(user.sub, id);
    return { success: true };
  }

  // ---- Acceptance flow ----

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Сдать свою работу (Исполнитель/Соисполнитель). Самозадача — закрывается сразу' })
  async submit(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const task = await this.tasksService.submitWork(user.sub, id);
    return { success: true, data: task };
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Принять работу участника (Постановщик)' })
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
  @ApiOperation({ summary: 'Вернуть работу участника в работу (Постановщик)' })
  async returnWork(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { participantUserId } = taskParticipantActionSchema.parse(body ?? {});
    const task = await this.tasksService.returnWork(user.sub, id, participantUserId);
    return { success: true, data: task };
  }

  // ---- Chat (per-task comments, open to all roles) ----

  @Get(':id/comments')
  @ApiOperation({ summary: 'Чат задачи' })
  async getComments(
    @CurrentUser() user: JwtPayload,
    @Param('id') taskId: string,
    @Query('page') page?: string,
  ) {
    const comments = await this.tasksService.getComments(
      user.sub, taskId, page ? parseInt(page, 10) : 1,
    );
    return { success: true, data: comments };
  }

  @Post(':id/comments')
  @ApiOperation({ summary: 'Написать в чат задачи' })
  async addComment(
    @CurrentUser() user: JwtPayload,
    @Param('id') taskId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { content } = addTaskCommentSchema.parse(body);
    const comment = await this.tasksService.addComment(user.sub, taskId, content);
    return { success: true, data: comment };
  }
}
