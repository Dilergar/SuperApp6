import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { journalQuerySchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ChatterService } from '../../core/chatter/chatter.service';

/**
 * «Журнал организации» — сводный B2B-аудит воркспейса на движке core/chatter
 * (кто кого нанял/повысил/уволил + движение задач организации). Path-based
 * (паттерн staff/office); гейт «роль ≥ Менеджер» живёт в ChatterService.listJournal.
 */
@ApiTags('Workspaces')
@ApiBearerAuth()
@Controller('workspaces/:id/journal')
export class WorkspaceJournalController {
  constructor(private readonly chatter: ChatterService) {}

  @Get()
  @ApiOperation({ summary: 'Журнал организации (хроника воркспейса; Менеджер+; фильтр category)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const q = journalQuerySchema.parse(query ?? {});
    return { success: true, data: await this.chatter.listJournal(user.sub, id, q) };
  }
}
