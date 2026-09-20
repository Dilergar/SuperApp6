import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  KEY_SCOPE_SERVICES,
  allScopeServices,
  apiKeyCreateSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  apiKeyUpdateSchema,
  apiKeyVerifySchema,
  keysLeakedSchema,
  type KeyScopeMatrixDto,
  type KeyScopeServiceDef,
} from '@superapp/shared';
import { z } from 'zod';
import { NoApiKeys } from '../../../shared/decorators/api-keys.decorator';
import { Idempotent, SkipIdempotency } from '../../../shared/decorators/idempotency.decorator';
import { CurrentUser, type JwtPayload } from '../../../shared/decorators/current-user.decorator';
import { Public } from '../../../shared/decorators/public.decorator';
import { ApiKeysService } from './api-keys.service';
import { KeysStepUpService } from './keys-step-up.service';

const confirmSchema = z.object({ verifyToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

function ipOf(req: Request): string | null {
  return req.ip ?? null;
}

/**
 * Личные ключи для СОБСТВЕННЫХ данных человека (без организации; такой ключ на рабочих
 * запросах с `X-Workspace-Id` отвергается), step-up управления ключами, сигнал сканера
 * утечек и validity-check. Управлять ключами ключом нельзя (`@NoApiKeys`).
 * Статические пути — ДО `:id`.
 */
@ApiTags('Keys')
@ApiBearerAuth()
@NoApiKeys()
@Controller('keys')
export class KeysController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly stepUp: KeysStepUpService,
  ) {}

  @Get('scope-matrix')
  @ApiOperation({ summary: 'Services available to keys (rows of the scope matrix)' })
  scopeMatrix(): { success: true; data: KeyScopeMatrixDto } {
    const services = allScopeServices().map((s) => {
      const def: KeyScopeServiceDef = KEY_SCOPE_SERVICES[s];
      return { service: s, bot: def.bot, botMax: def.bot ? def.botMax ?? 'write' : 'read' } as const;
    });
    return { success: true, data: { services: [...services] } };
  }

  @Get('step-up')
  @ApiOperation({ summary: 'Is the strong-confirmation window for key management open?' })
  async stepUpStatus(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.stepUp.status(user.sub) };
  }

  // Шаг подтверждения личности (OTP): ответ несёт пропуск step-up, а сам код
  // одноразовый — повтор с тем же кодом отвергнет core/verify
  @SkipIdempotency('own_mechanism')
  @Post('step-up/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume the verifyToken (purpose keys_manage) → 15-minute window' })
  async stepUpConfirm(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const { verifyToken } = confirmSchema.parse(body ?? {});
    return { success: true, data: await this.stepUp.confirm(user.sub, verifyToken) };
  }

  // Шаг подтверждения личности (OTP): ответ несёт пропуск step-up, а сам код
  // одноразовый — повтор с тем же кодом отвергнет core/verify
  @SkipIdempotency('own_mechanism')
  @Post('step-up/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close the strong-confirmation window now' })
  async stepUpEnd(@CurrentUser() user: JwtPayload) {
    await this.stepUp.end(user.sub);
    return { success: true, data: { until: null } };
  }

  @Get('personal')
  @ApiOperation({ summary: 'My personal keys for my own data' })
  async listPersonal(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.keys.listPersonal(user.sub, null) };
  }

  // Ответ показывает СЕКРЕТ один раз (тело ключа): снимка не существует —
  // повтор получит `409 already_completed` со ссылкой на выпущенный ключ
  @Idempotent({ required: true, store: 'none' })
  @Post('personal')
  @ApiOperation({ summary: 'Create a personal key for my own data (secret shown once)' })
  async createPersonal(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Req() req: Request) {
    const input = apiKeyCreateSchema.parse(body ?? {});
    return { success: true, data: await this.keys.createPersonal({ userId: user.sub, ip: ipOf(req) }, null, input) };
  }

  @Patch('personal/:id')
  @ApiOperation({ summary: 'Rename / note / IP allowlist of my personal key' })
  async updatePersonal(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.keys.update({ userId: user.sub, ip: ipOf(req) }, id, null, apiKeyUpdateSchema.parse(body ?? {})) };
  }

  // Ответ показывает СЕКРЕТ один раз (тело ключа): снимка не существует —
  // повтор получит `409 already_completed` со ссылкой на выпущенный ключ
  @Idempotent({ required: true, store: 'none' })
  @Post('personal/:id/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate my personal key (new secret shown once; the old one lives through the grace window)' })
  async rotatePersonal(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.keys.rotate({ userId: user.sub, ip: ipOf(req) }, id, null, apiKeyRotateSchema.parse(body ?? {})) };
  }

  @Post('personal/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke my personal key' })
  async revokePersonal(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const input = apiKeyRevokeSchema.parse(body ?? {});
    return { success: true, data: await this.keys.revoke({ userId: user.sub, ip: ipOf(req) }, id, null, input.reason ?? 'owner', input.note) };
  }

  /** Сигнал сканера секретов (GitHub secret scanning partner program и т.п.): найденные ключи гаснут. */
  @Public()
  // Сканер секретов нашего заголовка не шлёт и прислать не может, а повтор безопасен
  // по построению: уже отозванный ключ пропускается (`row.revokedAt` → continue)
  @SkipIdempotency('naturally_idempotent')
  @Post('leaked')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Leaked-secret signal: revoke every key found (no owner disclosed)' })
  async leaked(@Body() body: unknown) {
    const items = keysLeakedSchema.parse(body ?? []);
    return { success: true, data: await this.keys.leaked(items) };
  }

  // Только POST: секрет в query-строке (`GET ?key=`) осел бы в логах балансировщика,
  // CDN и истории браузера — проверка утечки сама становилась бы утечкой.
  @Public()
  // Диагностика интегратора: состояние ключа, ничего не меняет
  @SkipIdempotency('no_side_effects')
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Is this key alive? (POST only: no secrets in URLs; no owner or scopes disclosed)' })
  async verify(@Body() body: unknown) {
    const { key } = apiKeyVerifySchema.parse(body ?? {});
    return { success: true, data: await this.keys.verify(key) };
  }
}
