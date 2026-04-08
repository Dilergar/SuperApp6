import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import {
  CurrentUser,
  type JwtPayload,
} from '../../shared/decorators/current-user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Лента уведомлений текущего пользователя' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('cursor') cursor?: string,
  ) {
    const result = await this.notifications.list(user.sub, cursor);
    return { success: true, ...result };
  }

  @Post('mark-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Отметить уведомления прочитанными',
    description: 'Пустой массив (или отсутствующее поле) = отметить все непрочитанные.',
  })
  async markRead(
    @CurrentUser() user: JwtPayload,
    @Body() body: { notificationIds?: string[] },
  ) {
    const result = await this.notifications.markRead(user.sub, body?.notificationIds);
    return { success: true, ...result };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить уведомление' })
  async delete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.notifications.delete(user.sub, id);
    return { success: true };
  }
}
