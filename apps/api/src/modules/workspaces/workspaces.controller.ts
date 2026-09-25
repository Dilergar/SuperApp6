import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WorkspacesService } from './workspaces.service';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { SkipConsentGate } from '../../shared/decorators/skip-consent-gate.decorator';
import {
  CurrentUser,
  type JwtPayload,
} from '../../shared/decorators/current-user.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import {
  createWorkspaceSchema,
  updateWorkspaceProfileSchema,
  transferOwnershipSchema,
  inviteWorkspaceMemberSchema,
  updateWorkspaceMemberSchema,
  workspaceRequisitesSchema,
  createBankAccountSchema,
  updateBankAccountSchema,
  workspaceCardPreviewQuerySchema,
  type WorkspaceArchiveResultDto,
} from '@superapp/shared';
import { z } from 'zod';
import { isDevEnv } from '../../shared/config/env.validation';

const devPurgeBody = z
  .object({
    workspaceId: z.string().uuid().optional(),
    // Уборка (gc-test-workspaces.cjs): человек подтверждает объём сверх порога «подозрительно много»
    force: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const devOrphansBody = z.object({ apply: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20) }).strict();

@ApiTags('Workspaces')
@ApiBearerAuth()
@Controller('workspaces')
export class WorkspacesController {
  constructor(private workspaces: WorkspacesService) {}

  // ----- Workspaces -----

  @Get()
  @ApiOperation({ summary: 'My organizations (for the switcher)' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.workspaces.listMyWorkspaces(user.sub);
    return { success: true, data };
  }

  // Повтор = ВТОРАЯ организация: она съедает место в тарифе, а убирается только
  // архивом с последующей чисткой — «отменить» её одним движением нельзя.
  @Idempotent({ required: true })
  @Post()
  @ApiOperation({ summary: 'Create an organization' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Req() req: Request) {
    const data = createWorkspaceSchema.parse(body);
    const ua = req.headers['user-agent'];
    // IP и User-Agent — часть доказательства согласия владельца (core/consents); IP только из `req.ip`
    const ws = await this.workspaces.createWorkspace(user.sub, data, { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null });
    return { success: true, data: ws };
  }

  @Get('archived')
  @ApiOperation({ summary: 'The archive: my deactivated organizations (owner)' })
  async listArchived(@CurrentUser() user: JwtPayload) {
    const data = await this.workspaces.listArchivedWorkspaces(user.sub);
    return { success: true, data };
  }

  /**
   * Прогнать ретеншн архива немедленно (удаление созревшего + предупреждения за 7/3/1
   * день) — полигон verify-workspace-restore.cjs: ждать ночного крона тест не может.
   * Только в объявленных development/test (`isDevEnv`, как у остальных дев-полигонов:
   * CI гоняет сьюты с NODE_ENV=test); в любом другом окружении ручки будто нет.
   */
  @NoApiKeys()
  @Post('dev/purge-archives')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'DEV: run the archive retention right now (development/test only)' })
  async devPurgeArchives(@CurrentUser() user: JwtPayload, @Body() raw?: unknown) {
    if (!isDevEnv()) throw new NotFoundException();
    const body = devPurgeBody.parse(raw ?? {});
    // Purge КОНКРЕТНОЙ организации сейчас (КЭДО: «личный архив переживает purge»; уборка
    // сьютов) — ждать 90 дней ретеншна тест не может. Только своей и только из архива:
    // база разработки общая, и по одному id стиралась бы живая организация человека.
    if (body.workspaceId) {
      await this.workspaces.purgeArchivedWorkspaceNow(user.sub, body.workspaceId);
      return { success: true, data: { purged: 1, warned: 0 } };
    }
    // Дев: каскад каждой созревшей организации — сразу, а не джобом (сьюты ждут результата)
    const purged = await this.workspaces.purgeExpiredArchives({ inline: true, force: body.force, limit: body.limit });
    const warned = await this.workspaces.warnExpiringArchives();
    return { success: true, data: { purged, warned } };
  }

  /**
   * Хвосты организаций, которых УЖЕ НЕТ: без `apply` — сколько их; с `apply` — прогнать
   * по первым `limit` первую фазу каскада удаления (данные движков и сервисов). Живые и
   * архивные организации не трогаются по построению. Клиент — `gc-orphan-workspace-data.cjs`.
   * Только development/test (`isDevEnv`): в любом другом окружении ручки будто нет.
   */
  @NoApiKeys()
  @Post('dev/purge-orphans')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'DEV: list (or with apply purge) engine data of organizations that no longer exist (development/test only)' })
  async devPurgeOrphans(@Body() raw?: unknown) {
    if (!isDevEnv()) throw new NotFoundException();
    const body = devOrphansBody.parse(raw ?? {});
    const ids = await this.workspaces.orphanedWorkspaceIds();
    if (!body.apply) {
      return { success: true, data: { orphaned: ids.length, purged: 0, report: await this.workspaces.orphanReport(ids) } };
    }
    const batch = ids.slice(0, body.limit);
    for (const id of batch) await this.workspaces.purgeWorkspaceData(id);
    return { success: true, data: { orphaned: ids.length, purged: batch.length } };
  }

  // ----- Incoming invitations (must precede ':id' routes) -----

  @Get('invitations/incoming')
  @ApiOperation({ summary: 'My incoming invitations to organizations' })
  async incomingInvitations(@CurrentUser() user: JwtPayload) {
    const data = await this.workspaces.listIncomingInvitations(user.sub);
    return { success: true, data };
  }

  @Post('invitations/:invId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation to an organization' })
  async acceptInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('invId') invId: string,
  ) {
    const data = await this.workspaces.acceptInvitation(user.sub, invId);
    return { success: true, data };
  }

  @Post('invitations/:invId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline an invitation to an organization' })
  async rejectInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('invId') invId: string,
  ) {
    await this.workspaces.rejectInvitation(user.sub, invId);
    return { success: true };
  }

  // ----- Single workspace -----

  @Get(':id')
  @ApiOperation({ summary: 'The organization (with my role)' })
  async get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.workspaces.getWorkspace(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/card-preview')
  // Предпросмотр политики видимости — экран владельца/админа, не операция интеграции
  @NoApiKeys()
  @ApiOperation({ summary: 'The organization profile as a role sees it (owner/admin; the visibility engine decides)' })
  async cardPreview(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() q: unknown) {
    const { role } = workspaceCardPreviewQuerySchema.parse(q ?? {});
    const data = await this.workspaces.cardPreview(user.sub, id, role);
    return { success: true, data };
  }

  // ----- Реквизиты (блок «Анкеты компании»: юрформа, БИН, банк, директор) -----

  @Get(':id/requisites')
  @ApiOperation({ summary: 'The details of the organization + its bank accounts (employees see them by the visibility flag)' })
  async getRequisites(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.workspaces.getRequisites(user.sub, id);
    return { success: true, data };
  }

  @Patch(':id/requisites')
  @ApiOperation({ summary: 'Update the details (admin+; null clears a field)' })
  async updateRequisites(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = workspaceRequisitesSchema.parse(body);
    const data = await this.workspaces.updateRequisites(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/requisites/accounts')
  @ApiOperation({ summary: 'Add a bank account (admin+; the first one becomes the main one)' })
  async addBankAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = createBankAccountSchema.parse(body);
    const data = await this.workspaces.addBankAccount(user.sub, id, dto);
    return { success: true, data };
  }

  @Patch(':id/requisites/accounts/:accId')
  @ApiOperation({ summary: 'Change a bank account / make it the main one (admin+)' })
  async updateBankAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('accId') accId: string,
    @Body() body: unknown,
  ) {
    const dto = updateBankAccountSchema.parse(body);
    const data = await this.workspaces.updateBankAccount(user.sub, id, accId, dto);
    return { success: true, data };
  }

  @Delete(':id/requisites/accounts/:accId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a bank account (admin+)' })
  async removeBankAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('accId') accId: string,
  ) {
    const data = await this.workspaces.removeBankAccount(user.sub, id, accId);
    return { success: true, data };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update the profile of the organization (admin+)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = updateWorkspaceProfileSchema.parse(body);
    const ws = await this.workspaces.updateWorkspace(user.sub, id, data);
    return { success: true, data: ws };
  }

  // Вне шлюза согласий: владелец, НЕ принимающий новые условия, обязан иметь выход — удалить аккаунт.
  // Единственное владение организацией удаление блокирует (мотивированный отказ), поэтому архив,
  // передача владения и список сотрудников (кому передать) работают и за блокирующим экраном.
  @SkipConsentGate()
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate the organization (owner)' })
  async deactivate(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<{ success: true; data: WorkspaceArchiveResultDto }> {
    return { success: true, data: await this.workspaces.deactivateWorkspace(user.sub, id) };
  }

  @NoApiKeys()
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a deactivated organization (owner)' })
  async restore(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.workspaces.restoreWorkspace(user.sub, id);
    return { success: true };
  }

  // Передача владения необратима: прежний владелец теряет права на организацию и
  // вернуть их сам уже не может.
  @Idempotent({ required: true })
  @SkipConsentGate()
  @NoApiKeys()
  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer the ownership (owner)' })
  async transfer(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = transferOwnershipSchema.parse(body);
    await this.workspaces.transferOwnership(user.sub, id, data.toUserId);
    return { success: true };
  }

  @NoApiKeys()
  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave the organization (anyone but the owner)' })
  async leave(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.workspaces.leaveWorkspace(user.sub, id);
    return { success: true };
  }

  // ----- Members -----

  @SkipConsentGate()
  @Get(':id/members')
  @ApiOperation({ summary: 'The employees of the organization' })
  async members(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.workspaces.listMembers(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/members/:userId')
  @ApiOperation({ summary: 'One employee: the card + the details (the set for contracts — manager+)' })
  async member(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    const data = await this.workspaces.getMember(user.sub, id, targetUserId);
    return { success: true, data };
  }

  @Patch(':id/members/:userId')
  @ApiOperation({ summary: 'Change the role of an employee (admin+; an administrator — the owner only)' })
  async updateMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() body: unknown,
  ) {
    const data = updateWorkspaceMemberSchema.parse(body);
    await this.workspaces.updateMember(user.sub, id, targetUserId, data);
    return { success: true };
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss an employee (admin+)' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    await this.workspaces.removeMember(user.sub, id, targetUserId);
    return { success: true };
  }

  // ----- Outgoing invitations -----

  // Приглашение УХОДИТ человеку (SMS на номер): повтор — второе приглашение,
  // которое отзывать придётся отдельно.
  @Idempotent({ required: true })
  @Post(':id/invitations')
  @ApiOperation({ summary: 'Hire by phone number — always as a Trainee (manager+)' })
  async invite(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = inviteWorkspaceMemberSchema.parse(body);
    const inv = await this.workspaces.inviteMember(user.sub, id, data);
    return { success: true, data: inv };
  }

  @Get(':id/invitations')
  @ApiOperation({ summary: 'The outgoing invitations of the organization (manager+)' })
  async outgoingInvitations(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const data = await this.workspaces.listOutgoingInvitations(user.sub, id);
    return { success: true, data };
  }

  @Post(':id/invitations/:invId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an invitation (manager+)' })
  async cancelInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('invId') invId: string,
  ) {
    await this.workspaces.cancelInvitation(user.sub, id, invId);
    return { success: true };
  }
}
