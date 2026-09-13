import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { isDevEnv } from '../../shared/config/env.validation';
import { forbidden } from '../../shared/errors/api-error';
import { PlatformCapability, PlatformRoute } from '../../shared/decorators/platform.decorator';
import { AnalyticsIngestService } from './analytics.ingest.service';
import { AnalyticsPartitions } from './analytics.partitions';
import { AnalyticsRollupService } from './analytics.rollup.service';

const dayBody = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

/**
 * Дев-полигон аналитики (только development/test, регистрируется модулем лишь в dev):
 * сьют не ждёт кронов — дренирует outbox, пересчитывает день и обслуживает партиции
 * синхронно. Под гардом кабинета и capability `analytics.manage`: дев-ручка — не дыра.
 */
@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
@Controller('platform/analytics/dev')
export class AnalyticsDevController {
  constructor(
    private readonly ingest: AnalyticsIngestService,
    private readonly rollup: AnalyticsRollupService,
    private readonly partitions: AnalyticsPartitions,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @PlatformCapability('analytics.manage')
  @Post('drain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Drain the analytics outbox now' })
  async drain() {
    this.assertDev();
    return { success: true, data: { drained: await this.ingest.drainOutbox() } };
  }

  @PlatformCapability('analytics.manage')
  @Post('rollup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Rebuild the rollups of one day synchronously' })
  async rollupDay(@Body() body: unknown) {
    this.assertDev();
    const { day } = dayBody.parse(body ?? {});
    return { success: true, data: await this.rollup.rollupDay(day) };
  }

  @PlatformCapability('analytics.manage')
  @Post('partitions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Create partitions ahead and drop the ones past retention' })
  async maintainPartitions() {
    this.assertDev();
    await this.partitions.ensureAhead();
    const dropped = await this.partitions.dropExpired();
    return { success: true, data: { dropped, partitions: (await this.partitions.list()).map((p) => p.name) } };
  }
}
