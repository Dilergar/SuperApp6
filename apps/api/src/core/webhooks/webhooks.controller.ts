import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { webhookDeliveriesQuerySchema, webhookEndpointCreateSchema, webhookEndpointUpdateSchema, webhookRotateSecretSchema } from '@superapp/shared';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import type { KeyActor } from '../keys/api-keys/api-keys.service';
import { WebhooksRegistry } from './webhooks.registry';
import { WebhooksService } from './webhooks.service';

/** Каталог событий — любому вошедшему (форма endpoint'а). */
@ApiTags('Webhooks')
@ApiBearerAuth()
@Controller('webhooks')
export class WebhooksCatalogController {
  constructor(private readonly registry: WebhooksRegistry) {}

  @Get('events')
  @ApiOperation({ summary: 'Catalog of webhook events by service' })
  events() {
    return { success: true, data: this.registry.catalog() };
  }
}

/**
 * Endpoint'ы организации: владелец/админ, step-up у создания и ротации секрета,
 * ключом API управлять нельзя. Статические пути — до `:id`.
 */
@ApiTags('Webhooks')
@ApiBearerAuth()
@NoApiKeys()
@Controller('workspaces/:workspaceId/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  private actor(user: JwtPayload, req: Request): KeyActor {
    return { userId: user.sub, ip: req.ip ?? null };
  }

  @Get('endpoints')
  @ApiOperation({ summary: 'Webhook endpoints of the organization' })
  async list(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Req() req: Request) {
    return { success: true, data: await this.webhooks.list(this.actor(user, req), workspaceId) };
  }

  @Post('endpoints')
  @ApiOperation({ summary: 'Create an endpoint (signing secret shown once; verification ping is sent)' })
  async create(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.webhooks.create(this.actor(user, req), workspaceId, webhookEndpointCreateSchema.parse(body ?? {})) };
  }

  @Patch('endpoints/:id')
  @ApiOperation({ summary: 'Update events / enable / disable an endpoint' })
  async update(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.webhooks.update(this.actor(user, req), workspaceId, id, webhookEndpointUpdateSchema.parse(body ?? {})) };
  }

  @Post('endpoints/:id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the signing secret (old one keeps signing for prevHours)' })
  async rotate(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.webhooks.rotateSecret(this.actor(user, req), workspaceId, id, webhookRotateSecretSchema.parse(body ?? {})) };
  }

  @Post('endpoints/:id/probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a verification ping now' })
  async probe(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Req() req: Request) {
    return { success: true, data: await this.webhooks.probe(this.actor(user, req), workspaceId, id) };
  }

  @Delete('endpoints/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an endpoint (deliveries stop; journal keeps the history)' })
  async remove(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Req() req: Request) {
    await this.webhooks.delete(this.actor(user, req), workspaceId, id);
    return { success: true };
  }

  @Get('endpoints/:id/deliveries')
  @ApiOperation({ summary: 'Recent deliveries of an endpoint' })
  async deliveries(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Query() query: Record<string, string>, @Req() req: Request) {
    return { success: true, data: await this.webhooks.deliveries(this.actor(user, req), workspaceId, id, webhookDeliveriesQuerySchema.parse(query ?? {})) };
  }

  @Post('endpoints/:id/deliveries/:deliveryId/redeliver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Queue a delivery again' })
  async redeliver(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Param('deliveryId') deliveryId: string, @Req() req: Request) {
    await this.webhooks.redeliver(this.actor(user, req), workspaceId, id, deliveryId);
    return { success: true };
  }
}
