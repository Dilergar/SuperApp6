import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QUICK_ACTION_SCOPES, type QuickActionScope } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { QuickActionsService } from './quick-actions.service';

/**
 * Quick actions for the chat menus (core/quick-actions). The web renders the ＋-menu
 * (scope=composer) and a message's corner menu (scope=message) from this.
 */
@ApiTags('Quick Actions')
@ApiBearerAuth()
@Controller('quick-actions')
export class QuickActionsController {
  constructor(private readonly quickActions: QuickActionsService) {}

  @Get()
  @ApiOperation({ summary: 'Доступные быстрые действия для чата (＋-меню / меню сообщения)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('chatId') chatId?: string,
    @Query('scope') scope?: string,
  ) {
    if (!chatId) throw new BadRequestException('chatId обязателен');
    const s: QuickActionScope = QUICK_ACTION_SCOPES.includes(scope as QuickActionScope)
      ? (scope as QuickActionScope)
      : 'composer';
    return { success: true, data: await this.quickActions.listForChat(user.sub, chatId, s) };
  }
}
