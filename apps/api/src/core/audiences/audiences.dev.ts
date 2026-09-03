import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AUDIENCE_KINDS, audienceListSchema } from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { AudiencesService } from './audiences.service';

const devResolveSchema = z
  .object({
    workspaceId: z.string().uuid().nullable().optional(),
    refs: audienceListSchema(AUDIENCE_KINDS, 50),
    initiatorId: z.string().uuid().optional(),
    subjectId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    max: z.number().int().min(1).max(5000).optional(),
    onOverflow: z.enum(['throw', 'truncate']).optional(),
  })
  .strict();

/**
 * Дев-полигон движка адресатов (только development/test — в production маршрута НЕТ):
 * сьют проверяет разворот и подписи напрямую, а «одинаковый состав у всех потребителей»
 * — сравнением с настоящим снимком шага согласования. `$self` = вызывающий.
 */
@ApiTags('Audiences')
@ApiBearerAuth()
@Controller('audiences/dev')
export class AudiencesDevController {
  constructor(private readonly audiences: AudiencesService) {}

  @Post('resolve')
  @ApiOperation({ summary: 'DEV: развернуть адресатов в людей + подписи' })
  async resolve(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = devResolveSchema.parse(body);
    const ctx = {
      workspaceId: dto.workspaceId ?? null,
      initiatorId: dto.initiatorId ?? user.sub,
      subjectId: dto.subjectId ?? null,
      selfId: user.sub,
      branchId: dto.branchId ?? null,
    };
    const userIds = await this.audiences.resolve(dto.refs, ctx, {
      max: dto.max ?? 500,
      onOverflow: dto.onOverflow ?? 'throw',
    });
    const labels = await this.audiences.labelMany(dto.refs, ctx);
    return { success: true, data: { userIds, labels } };
  }
}
