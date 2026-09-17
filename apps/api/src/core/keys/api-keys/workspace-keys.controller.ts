import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  apiKeyCreateSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  apiKeyUpdateSchema,
  botCreateSchema,
  botKeyCreateSchema,
  botUnfreezeSchema,
  botUpdateSchema,
  keyJournalQuerySchema,
  keyPolicyUpdateSchema,
  keyRegistryQuerySchema,
} from '@superapp/shared';
import { NoApiKeys } from '../../../shared/decorators/api-keys.decorator';
import { CurrentUser, type JwtPayload } from '../../../shared/decorators/current-user.decorator';
import { ApiKeysService, type KeyActor } from './api-keys.service';
import { BotsService } from './bots.service';
import { KeysRegistryService } from './keys.registry.service';

/**
 * Реестр ключей организации: боты, личные ключи для данных организации, журнал, политика.
 * Право — owner/admin (сервисы: `assertManager` → 403 `keys.role_required`), step-up у
 * создания/ротации/разморозки/архива. Ключом управлять ключами нельзя.
 * Статические пути (`registry`, `pending`, `journal`, `policy`, `bots`, `keys`) — до `:botId`.
 */
@ApiTags('Keys')
@ApiBearerAuth()
@NoApiKeys()
@Controller('workspaces/:workspaceId/keys')
export class WorkspaceKeysController {
  constructor(
    private readonly registry: KeysRegistryService,
    private readonly bots: BotsService,
    private readonly keys: ApiKeysService,
  ) {}

  private actor(user: JwtPayload, req: Request): KeyActor {
    return { userId: user.sub, ip: req.ip ?? null };
  }

  @Get('registry')
  @ApiOperation({ summary: 'Key registry of the organization (bots, personal keys, webhooks) with filters' })
  async registryList(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Query() query: Record<string, string>, @Req() req: Request) {
    return { success: true, data: await this.registry.list(this.actor(user, req), workspaceId, keyRegistryQuerySchema.parse(query ?? {})) };
  }

  @Get('pending')
  @ApiOperation({ summary: 'Bots waiting for the owner decision (header badge)' })
  async pending(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Req() req: Request) {
    return { success: true, data: await this.registry.pending(this.actor(user, req), workspaceId) };
  }

  @Get('journal')
  @ApiOperation({ summary: 'Append-only journal of key/bot/webhook actions' })
  async journal(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Query() query: Record<string, string>, @Req() req: Request) {
    return { success: true, data: await this.registry.journal(this.actor(user, req), workspaceId, keyJournalQuerySchema.parse(query ?? {})) };
  }

  @Get('policy')
  @ApiOperation({ summary: 'Key policy of the organization (term ceilings, IP allowlist requirement)' })
  async policy(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Req() req: Request) {
    return { success: true, data: await this.registry.policyOf(this.actor(user, req), workspaceId) };
  }

  @Patch('policy')
  @ApiOperation({ summary: 'Update the key policy (owner only)' })
  async updatePolicy(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.registry.updatePolicy(this.actor(user, req), workspaceId, keyPolicyUpdateSchema.parse(body ?? {})) };
  }

  // ---- Боты ----

  @Get('bots')
  @ApiOperation({ summary: 'Bots of the organization' })
  async listBots(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Req() req: Request) {
    return { success: true, data: await this.bots.list(this.actor(user, req), workspaceId) };
  }

  @Post('bots')
  @ApiOperation({ summary: 'Create a bot with its first key (secret shown once; step-up required)' })
  async createBot(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.bots.create(this.actor(user, req), workspaceId, botCreateSchema.parse(body ?? {})) };
  }

  @Get('bots/:botId')
  @ApiOperation({ summary: 'Bot card with its keys' })
  async getBot(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('botId') botId: string, @Req() req: Request) {
    return { success: true, data: await this.bots.get(this.actor(user, req), workspaceId, botId) };
  }

  @Patch('bots/:botId')
  @ApiOperation({ summary: 'Update a bot (name, purpose, rank, responsible person, scopes, IP allowlist)' })
  async updateBot(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('botId') botId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.bots.update(this.actor(user, req), workspaceId, botId, botUpdateSchema.parse(body ?? {})) };
  }

  @Post('bots/:botId/keys')
  @ApiOperation({ summary: 'Issue another key for the bot (secret shown once; step-up required)' })
  async createBotKey(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('botId') botId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.bots.createKey(this.actor(user, req), workspaceId, botId, botKeyCreateSchema.parse(body ?? {})) };
  }

  @Post('bots/:botId/freeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Freeze a bot (its keys stop working; nothing is deleted)' })
  async freezeBot(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('botId') botId: string, @Req() req: Request) {
    return { success: true, data: await this.bots.freeze(this.actor(user, req), workspaceId, botId) };
  }

  @Post('bots/:botId/unfreeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unfreeze a bot (owner only, step-up required)' })
  async unfreezeBot(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('botId') botId: string, @Body() body: unknown, @Req() req: Request) {
    const input = botUnfreezeSchema.parse(body ?? {});
    return { success: true, data: await this.bots.unfreeze(this.actor(user, req), workspaceId, botId, input.note) };
  }

  @Delete('bots/:botId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a bot: keys revoked, roles removed (step-up required)' })
  async archiveBot(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('botId') botId: string, @Req() req: Request) {
    await this.bots.archive(this.actor(user, req), workspaceId, botId);
    return { success: true };
  }

  // ---- Личные ключи для данных организации (owner/admin) и ключи ботов ----

  @Get('keys')
  @ApiOperation({ summary: 'Personal keys issued for this organization data' })
  async listKeys(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Req() req: Request) {
    await this.keys.assertManager(user.sub, workspaceId);
    return { success: true, data: await this.keys.listWorkspacePersonal(workspaceId) };
  }

  @Post('keys')
  @ApiOperation({ summary: 'Create a personal key for this organization data (owner/admin; secret shown once)' })
  async createKey(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.keys.createPersonal(this.actor(user, req), workspaceId, apiKeyCreateSchema.parse(body ?? {})) };
  }

  @Patch('keys/:keyId')
  @ApiOperation({ summary: 'Rename / note / IP allowlist of a key of this organization' })
  async updateKey(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('keyId') keyId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.keys.update(this.actor(user, req), keyId, workspaceId, apiKeyUpdateSchema.parse(body ?? {})) };
  }

  @Post('keys/:keyId/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a key of this organization (bot or personal; step-up required)' })
  async rotateKey(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('keyId') keyId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.keys.rotate(this.actor(user, req), keyId, workspaceId, apiKeyRotateSchema.parse(body ?? {})) };
  }

  @Post('keys/:keyId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a key of this organization' })
  async revokeKey(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('keyId') keyId: string, @Body() body: unknown, @Req() req: Request) {
    const input = apiKeyRevokeSchema.parse(body ?? {});
    return { success: true, data: await this.keys.revoke(this.actor(user, req), keyId, workspaceId, input.reason ?? 'owner', input.note) };
  }
}
