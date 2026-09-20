import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  platformAuditQuerySchema,
  platformAuthStartSchema,
  platformCommandPreviewSchema,
  platformCommandRunSchema,
  platformEntitySchema,
  platformLoginSchema,
  platformLookupQuerySchema,
  platformRequestDecideSchema,
  platformRequestsQuerySchema,
  platformStepUpConfirmSchema,
  platformStepUpStartSchema,
} from '@superapp/shared';
import { z } from 'zod';
import {
  CurrentPlatformActor,
  PlatformCapability,
  PlatformPublic,
  PlatformRoute,
  PlatformSession,
  type PlatformActor,
} from '../../shared/decorators/platform.decorator';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { PlatformAccessService } from './platform-access.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformCommandsService } from './platform-commands.service';
import { PlatformLookupService } from './platform-lookup.service';
import { PlatformRequestsService } from './platform-requests.service';

// ============================================================
// Контроллеры кабинета. Все под @PlatformRoute(): продуктовый гард их пропускает,
// PlatformAuthGuard — deny by default. Публичны ТОЛЬКО start/login (вход).
// Заголовок X-Workspace-Id отвергается гардом (S16). Статические пути ДО :id.
// ============================================================

const clientIp = (req: Request): string | undefined => req.ip;
const userAgent = (req: Request): string | null => (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null);

@ApiTags('Platform console')
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @PlatformPublic()
  @Post('start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Console sign-in, step 1: password → SMS code (does not reveal staff membership)' })
  async start(@Body() body: unknown, @Req() req: Request) {
    const dto = platformAuthStartSchema.parse(body ?? {});
    return { success: true, data: await this.auth.start(dto.phone, dto.password, clientIp(req)) };
  }

  @PlatformPublic()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 10, ttl: 900000 } })
  @ApiOperation({ summary: 'Console sign-in, step 2: verifyToken → console access token (8h, no refresh)' })
  async login(@Body() body: unknown, @Req() req: Request) {
    const dto = platformLoginSchema.parse(body ?? {});
    return { success: true, data: await this.auth.login(dto.verifyToken, { ip: clientIp(req) ?? null, userAgent: userAgent(req) }) };
  }

  @PlatformSession()
  @Post('step-up/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 10, ttl: 900000 } })
  @ApiOperation({ summary: 'Sudo step 1: password → SMS code' })
  async stepUpStart(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: Request) {
    const dto = platformStepUpStartSchema.parse(body ?? {});
    return { success: true, data: await this.auth.stepUpStart(actor, dto.password, clientIp(req)) };
  }

  @PlatformSession()
  @Post('step-up/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sudo step 2: verifyToken → 15-minute sudo window' })
  async stepUpConfirm(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown) {
    const dto = platformStepUpConfirmSchema.parse(body ?? {});
    return { success: true, data: await this.auth.stepUpConfirm(actor, dto.verifyToken) };
  }

  @PlatformSession()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke this console session' })
  async logout(@CurrentPlatformActor() actor: PlatformActor) {
    await this.auth.logout(actor);
    return { success: true, data: { ok: true } };
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform')
export class PlatformMeController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly access: PlatformAccessService,
    private readonly commands: PlatformCommandsService,
  ) {}

  @PlatformSession()
  @Get('me')
  @ApiOperation({ summary: 'Who am I in the console: roles, capabilities, sudo window, policy' })
  async me(@CurrentPlatformActor() actor: PlatformActor) {
    return { success: true, data: await this.auth.me(actor) };
  }

  @PlatformCapability('platform.staff.read')
  @Get('staff')
  @ApiOperation({ summary: 'Platform staff with roles' })
  async staff() {
    return { success: true, data: await this.access.listStaff() };
  }

  @PlatformSession()
  @Get('commands')
  @ApiOperation({ summary: 'Commands visible to the actor (input schema as JSON Schema)' })
  async list(@CurrentPlatformActor() actor: PlatformActor) {
    return { success: true, data: this.commands.listFor(actor) };
  }

  @PlatformSession()
  @Post('commands/:key/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Preview a command: execute inside a transaction that always rolls back' })
  async preview(@CurrentPlatformActor() actor: PlatformActor, @Param('key') key: string, @Body() body: unknown) {
    const dto = platformCommandPreviewSchema.parse(body ?? {});
    return { success: true, data: await this.commands.preview(actor, key, dto.input) };
  }

  @PlatformSession()
  @Post('commands/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run a command: capability → step-up → reason → dual control → idempotency → audit' })
  async run(@CurrentPlatformActor() actor: PlatformActor, @Param('key') key: string, @Body() body: unknown) {
    const dto = platformCommandRunSchema.parse(body ?? {});
    return { success: true, data: await this.commands.run(actor, key, dto) };
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/audit')
export class PlatformAuditController {
  constructor(private readonly audit: PlatformAuditService) {}

  @PlatformCapability('platform.audit.read')
  @Get()
  @ApiOperation({ summary: 'Command journal (append-only), cursor page' })
  async list(@Query() query: Record<string, string>) {
    const q = platformAuditQuerySchema.parse(query ?? {});
    return { success: true, data: await this.audit.list(q) };
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/lookup')
export class PlatformLookupController {
  constructor(private readonly lookup: PlatformLookupService) {}

  @PlatformCapability('platform.lookup.read')
  @Get()
  @Throttle({ long: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Search people and organizations: full phone, 12-digit IIN/BIN, uuid or text (masked)' })
  async search(@CurrentPlatformActor() actor: PlatformActor, @Query() query: Record<string, string>) {
    const q = platformLookupQuerySchema.parse(query ?? {});
    return { success: true, data: await this.lookup.lookup(actor, q.q) };
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/entities')
export class PlatformEntitiesController {
  constructor(private readonly lookup: PlatformLookupService) {}

  @PlatformCapability('platform.lookup.read')
  @Get(':entity/:id')
  @ApiOperation({ summary: '360 card: header, chips, available panels and commands' })
  async entity(@CurrentPlatformActor() actor: PlatformActor, @Param('entity') entity: string, @Param('id') id: string) {
    const e = platformEntitySchema.parse(entity);
    return { success: true, data: await this.lookup.entity(actor, e, z.string().uuid().parse(id)) };
  }

  @PlatformCapability('platform.lookup.read')
  @Get(':entity/:id/panels/:key')
  @ApiOperation({ summary: '360 card panel (lazy)' })
  async panel(@CurrentPlatformActor() actor: PlatformActor, @Param('entity') entity: string, @Param('id') id: string, @Param('key') key: string) {
    const e = platformEntitySchema.parse(entity);
    return { success: true, data: await this.lookup.panel(actor, e, z.string().uuid().parse(id), key) };
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/requests')
export class PlatformRequestsController {
  constructor(private readonly requests: PlatformRequestsService) {}

  @PlatformCapability('platform.audit.read')
  @Get()
  @ApiOperation({ summary: 'Four-eyes queue: pending | mine | history' })
  async list(@CurrentPlatformActor() actor: PlatformActor, @Query() query: Record<string, string>) {
    const q = platformRequestsQuerySchema.parse(query ?? {});
    return { success: true, data: await this.requests.list(actor, q) };
  }

  @PlatformCapability('platform.audit.read')
  @Get(':id')
  @ApiOperation({ summary: 'One request' })
  async get(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string) {
    const row = await this.requests.get(actor, z.string().uuid().parse(id));
    return { success: true, data: row };
  }

  @PlatformSession()
  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my own pending request (the product route does not touch console requests)' })
  async withdraw(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string) {
    return { success: true, data: await this.requests.withdraw(actor, z.string().uuid().parse(id)) };
  }

  @PlatformSession()
  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a request (not the author; holder of the approving right)' })
  async decide(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
    const dto = platformRequestDecideSchema.parse(body ?? {});
    return { success: true, data: await this.requests.decide(actor, z.string().uuid().parse(id), dto.outcome, dto.comment) };
  }
}
