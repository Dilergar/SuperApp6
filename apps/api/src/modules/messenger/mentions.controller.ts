import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { MentionsService } from './mentions.service';

const markMentionsReadSchema = z
  .object({ ids: z.array(z.string().uuid()).optional() })
  .strict();

/**
 * Mentions Hub (Phase 5): a unified feed of every @mention OF the current user.
 * The chat-scoped mentionable-members picker lives on MessengerController
 * (GET messenger/chats/:id/mentionable) since it is chat-scoped.
 */
@ApiTags('Mentions')
@ApiBearerAuth()
@Controller('mentions')
export class MentionsController {
  constructor(private mentions: MentionsService) {}

  @Get()
  @ApiOperation({ summary: 'Лента упоминаний (Mentions Hub)' })
  async feed(@CurrentUser() user: JwtPayload, @Query('cursor') cursor?: string) {
    return { success: true, data: await this.mentions.listFeed(user.sub, cursor) };
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Только счётчик непрочитанных (бейдж навбара)' })
  async unreadCount(@CurrentUser() user: JwtPayload) {
    // Бейдж поллится раз в минуту с каждой вкладки — раньше ради одного числа
    // качалась полная первая страница ленты (4 запроса); теперь 1 индексный COUNT.
    return { success: true, data: { unreadCount: await this.mentions.unreadCount(user.sub) } };
  }

  @Post('mark-read')
  @ApiOperation({ summary: 'Отметить упоминания прочитанными (пусто = все)' })
  async markRead(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { ids } = markMentionsReadSchema.parse(body);
    await this.mentions.markRead(user.sub, ids);
    return { success: true };
  }
}
