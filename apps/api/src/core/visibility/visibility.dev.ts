import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { VISIBILITY_REDIS, isVisibilityRecordType, visibilityFieldsOf, visibilityTypeDef } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { badRequest, forbidden } from '../../shared/errors/api-error';
import { RedisService } from '../../shared/redis/redis.service';
import { VisibilityRevealService } from './visibility.reveal.service';
import { VisibilityScrapeDetector } from './visibility.scrape.service';
import { VisibilityService, type ShapeInput } from './visibility.service';

const benchBody = z
  .object({
    workspaceId: z.string().uuid().nullable().optional(),
    recordType: z.string().min(1).max(64),
    plans: z.number().int().min(1).max(10_000).optional(),
    rows: z.number().int().min(1).max(20_000).optional(),
  })
  .strict();
const userBody = z.object({ userId: z.string().uuid() }).strict();
const scrapeBody = z.object({ rows: z.number().int().min(1).max(1_000_000) }).strict();
const cacheQuery = z.object({ ownerKind: z.enum(['workspace', 'user']), ownerId: z.string().uuid(), recordType: z.string().min(1).max(64) }).strict();

/**
 * Дев-полигон движка видимости (только development/test): замер производительности
 * (цели плана: 1000 планов из кэша ≤ 1 с; `shape` 10 000 строк ≤ 200 мс), снятие паузы
 * раскрытий для сьюта, сырой ключ кэша политики (проверка инвалидации публикацией).
 */
@ApiTags('Visibility')
@ApiBearerAuth()
@NoApiKeys()
@Controller('visibility/dev')
export class VisibilityDevController {
  constructor(
    private readonly visibility: VisibilityService,
    private readonly reveals: VisibilityRevealService,
    private readonly scrape: VisibilityScrapeDetector,
    private readonly redis: RedisService,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @Post('bench')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Benchmark plan() from cache and shape() on synthetic rows' })
  async bench(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const b = benchBody.parse(body ?? {});
    if (!isVisibilityRecordType(b.recordType)) throw badRequest('visibility.unknown_record_type');
    const type = b.recordType;
    const ws = b.workspaceId ?? null;
    const viewer = this.visibility.viewerFor(user.sub, ws, 'api');
    const plans = b.plans ?? 1000;
    await this.visibility.planDto(viewer, type, ws); // прогрев кэша
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < plans; i++) await this.visibility.planDto(this.visibility.viewerFor(user.sub, ws, 'api'), type, ws);
    const planMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const def = visibilityTypeDef(type)!;
    const rowsN = b.rows ?? 10_000;
    const fields = visibilityFieldsOf(type);
    const inputs: ShapeInput[] = [];
    for (let i = 0; i < rowsN; i++) {
      const values: Record<string, unknown> = {};
      for (const f of fields) values[f.key] = f.def.kind === 'money' ? String(100_000 + i) : `v${i}`;
      inputs.push({ ref: { recordId: `r${i}`, subjectId: def.subject === 'user' ? user.sub : null, workspaceId: ws }, values });
    }
    const t1 = process.hrtime.bigint();
    await this.visibility.shape(viewer, type, inputs);
    const shapeMs = Number(process.hrtime.bigint() - t1) / 1e6;
    return { success: true, data: { plans, planMs: Math.round(planMs), rows: rowsN, fields: fields.length, shapeMs: Math.round(shapeMs) } };
  }

  @Post('lift-pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Lift a reveal pause and reset the detection window' })
  async liftPause(@Body() body: unknown) {
    this.assertDev();
    const { userId } = userBody.parse(body ?? {});
    await this.reveals.liftPause(userId);
    return { success: true, data: { lifted: true } };
  }

  /** Детекция скрейпинга без 20 000 живых строк: учесть N чужих строк за текущего человека. */
  @Post('scrape-probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Count N exposed rows for the current user in the scrape-detection window' })
  async scrapeProbe(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { rows } = scrapeBody.parse(body ?? {});
    const viewer = this.visibility.viewer('api');
    return { success: true, data: await this.scrape.tally(user.sub, viewer.workspaceId, 'user.card', rows) };
  }

  @Post('scrape-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Reset the scrape-detection window of the current user' })
  async scrapeReset(@CurrentUser() user: JwtPayload) {
    this.assertDev();
    await this.scrape.reset(user.sub);
    return { success: true, data: { reset: true } };
  }

  @Get('policy-cache')
  @ApiOperation({ summary: '[dev] Raw cached policy of an owner (invalidation checks)' })
  async policyCache(@Query() q: unknown) {
    this.assertDev();
    const { ownerKind, ownerId, recordType } = cacheQuery.parse(q ?? {});
    const raw = await this.redis.get(VISIBILITY_REDIS.policy(ownerKind, ownerId, recordType));
    return { success: true, data: raw ? JSON.parse(raw) : null };
  }
}
