import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { searchQuerySchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { SearchService } from './search.service';

/**
 * Unified search (core/search). One endpoint, three behaviours decided by params:
 *  • ?q=…                    → global grouped (Чаты / Люди / Сообщения)
 *  • ?q=…&chatId=…           → in-chat message search (paginated)
 *  • ?q=…&type=…&cursor=…    → a flat page of one source type ("показать ещё")
 */
@ApiTags('Search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Поиск (глобальный / в чате / постранично по типу)' })
  async query(@CurrentUser() user: JwtPayload, @Query() raw: Record<string, unknown>) {
    const input = searchQuerySchema.parse({
      q: raw.q,
      type: raw.type,
      chatId: raw.chatId,
      cursor: raw.cursor,
    });

    if (input.chatId) {
      return {
        success: true,
        data: await this.search.page(user.sub, input.q, 'message', { chatId: input.chatId, cursor: input.cursor }),
      };
    }
    if (input.type) {
      return {
        success: true,
        data: await this.search.page(user.sub, input.q, input.type, { cursor: input.cursor }),
      };
    }
    return { success: true, data: await this.search.global(user.sub, input.q) };
  }
}
