import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RICH_CARD_REF_TYPES } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent, SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { RichCardsService } from './rich-cards.service';

const refSchema = z.object({
  type: z.enum(RICH_CARD_REF_TYPES),
  id: z.string().min(1),
});

const executeSchema = z
  .object({
    ref: refSchema,
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

const shareSchema = z
  .object({
    chatId: z.string().min(1),
    refType: z.enum(RICH_CARD_REF_TYPES),
    refId: z.string().min(1),
  })
  .strict();

@ApiTags('Rich Cards')
@ApiBearerAuth()
@Controller('rich-cards')
export class RichCardsController {
  constructor(private readonly richCards: RichCardsService) {}

  // Общий диспетчер действий карточек: за ключом действия у потребителя могут
  // стоять и деньги, и подпись — ключ обязателен для ЛЮБОГО из них
  @Idempotent({ required: true })
  @Post(':actionKey/execute')
  @ApiOperation({ summary: 'Run a card action (re-renders the card)' })
  async execute(
    @CurrentUser() user: JwtPayload,
    @Param('actionKey') actionKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { ref, payload } = executeSchema.parse(body);
    return {
      success: true,
      data: await this.richCards.execute(user.sub, actionKey, ref, payload),
    };
  }

  @Post('share')
  @ApiOperation({ summary: 'Share an entity card into a chat' })
  async share(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { chatId, refType, refId } = shareSchema.parse(body);
    return {
      success: true,
      data: await this.richCards.shareToChat(user.sub, chatId, refType, refId),
    };
  }

  @Get(':refType/:refId')
  @ApiOperation({ summary: 'The current entity card as the viewer sees it' })
  async render(
    @CurrentUser() user: JwtPayload,
    @Param('refType') refType: string,
    @Param('refId') refId: string,
  ) {
    return { success: true, data: await this.richCards.render(user.sub, refType, refId) };
  }
}
