import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { createTaskSchema, updateTaskSchema } from '@superapp/shared';

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private tasksService: TasksService) {}

  @Get()
  @ApiOperation({ summary: 'Получить список задач' })
  async getTasks(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('parentId') parentId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const result = await this.tasksService.getTasks(user.sub, {
      status: status?.split(','),
      priority: priority?.split(','),
      assigneeId,
      workspaceId: workspaceId === 'null' ? null : workspaceId,
      parentId: parentId === 'null' ? null : parentId,
      search,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
    return { success: true, ...result };
  }

  @Post()
  @ApiOperation({ summary: 'Создать задачу' })
  async createTask(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
  ) {
    const data = createTaskSchema.parse(body);
    const task = await this.tasksService.createTask(user.sub, data);
    return { success: true, data: task };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Получить задачу с подзадачами' })
  async getTask(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const task = await this.tasksService.getTask(user.sub, id);
    return { success: true, data: task };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Обновить задачу' })
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
  @ApiOperation({ summary: 'Удалить задачу' })
  async deleteTask(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.tasksService.deleteTask(user.sub, id);
    return { success: true };
  }

  @Get(':id/comments')
  @ApiOperation({ summary: 'Комментарии к задаче' })
  async getComments(
    @CurrentUser() user: JwtPayload,
    @Param('id') taskId: string,
    @Query('page') page?: string,
  ) {
    const comments = await this.tasksService.getComments(
      user.sub, taskId, page ? parseInt(page) : 1,
    );
    return { success: true, data: comments };
  }

  @Post(':id/comments')
  @ApiOperation({ summary: 'Добавить комментарий' })
  async addComment(
    @CurrentUser() user: JwtPayload,
    @Param('id') taskId: string,
    @Body() body: { content: string },
  ) {
    const comment = await this.tasksService.addComment(user.sub, taskId, body.content);
    return { success: true, data: comment };
  }
}
