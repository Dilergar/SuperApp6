import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isDevEnv } from '../../shared/config/env.validation';
import { notFound } from '../../shared/errors/api-error';
import { LifecyclePartitions } from './lifecycle.partitions';

/**
 * Дев-полигон движка жизненного цикла (verify-partitions.cjs): здоровье партиций и ночное
 * обслуживание по запросу. Вне NODE_ENV=development — 404, как будто ручек нет; в проде
 * то же видит дашборд «Данные» Кабинета платформы (core/platform, Э5).
 */
@ApiTags('Lifecycle')
@ApiBearerAuth()
@Controller('lifecycle/dev')
export class LifecycleDevController {
  constructor(private readonly partitions: LifecyclePartitions) {}

  private assertDev(): void {
    if (!isDevEnv()) throw notFound('dev.developmentOnly');
  }

  @Get('partitions')
  @ApiOperation({ summary: '[dev] Health of every partitioned log: partitions ahead, detach pending, DEFAULT partition' })
  async health() {
    this.assertDev();
    const health = await this.partitions.health();
    return { success: true, data: health.map((h) => ({ ...h, oldestFrom: h.oldestFrom?.toISOString() ?? null })) };
  }

  @Post('partitions/maintain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the nightly partition maintenance now (ahead, retention drops, ANALYZE)' })
  async maintain() {
    this.assertDev();
    const { dropped, health } = await this.partitions.maintain();
    return { success: true, data: { dropped, health: health.map((h) => ({ ...h, oldestFrom: h.oldestFrom?.toISOString() ?? null })) } };
  }
}
