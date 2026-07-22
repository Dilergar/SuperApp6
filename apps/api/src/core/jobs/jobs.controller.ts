import { Body, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database/database.service';
import { JobsService } from './jobs.service';

/**
 * Дев-наблюдаемость движка джобов + полигон verify-jobs.cjs. ВСЁ — только при
 * NODE_ENV=development (прецедент Swagger//dev/files): в любом другом окружении
 * эндпоинты отвечают 404, как будто их нет. Админ-UI появится вместе с кабинетом
 * platform_admin (No Placeholder UI).
 */

// Дев-полигон — схема локальная (не в shared): это не контракт клиентов, а тестовая утилита.
const devEnqueueSchema = z
  .object({
    uniqueKey: z.string().min(1).max(200),
    sleepMs: z.number().int().min(0).max(60_000).optional(),
    failTimes: z.number().int().min(0).max(10).optional(),
    discard: z.boolean().optional(),
    runInSec: z.number().int().min(0).max(3600).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    rollback: z.boolean().optional(),
  })
  .strict();

const devKeySchema = z.object({ uniqueKey: z.string().min(1).max(200) }).strict();

export const DEV_ECHO_TYPE = 'jobs.dev.echo';

@ApiTags('Jobs')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly db: DatabaseService,
  ) {}

  private assertDev(): void {
    if (process.env.NODE_ENV !== 'development') throw new NotFoundException();
  }

  @Get('stats')
  @ApiOperation({ summary: 'Счётчики движка джобов + последние dead-letter (только development)' })
  async stats() {
    this.assertDev();
    return { success: true, data: await this.jobs.stats() };
  }

  @Post('dev/enqueue')
  @ApiOperation({ summary: 'Дев-полигон: поставить тест-джоб (в транзакции; rollback=true — откатить её)' })
  async devEnqueue(@Body() body: unknown) {
    this.assertDev();
    const input = devEnqueueSchema.parse(body ?? {});
    const runAt = input.runInSec ? new Date(Date.now() + input.runInSec * 1000) : undefined;
    try {
      await this.db.$transaction(async (tx) => {
        await this.jobs.enqueue(tx, {
          type: DEV_ECHO_TYPE,
          payload: {
            sleepMs: input.sleepMs,
            failTimes: input.failTimes,
            discard: input.discard,
          },
          uniqueKey: input.uniqueKey,
          runAt,
          maxAttempts: input.maxAttempts,
        });
        if (input.rollback) throw new Error('__dev_rollback__');
      });
    } catch (err) {
      if ((err as Error)?.message !== '__dev_rollback__') throw err;
    }
    return { success: true, data: { enqueued: !input.rollback } };
  }

  @Get('dev/by-key')
  @ApiOperation({ summary: 'Дев-полигон: состояние тест-джоба по uniqueKey (последняя строка)' })
  async devByKey(@Query() query: Record<string, unknown>) {
    this.assertDev();
    const { uniqueKey } = devKeySchema.parse(query ?? {});
    const row = await this.db.job.findFirst({
      where: { type: DEV_ECHO_TYPE, uniqueKey },
      orderBy: { id: 'desc' },
    });
    return {
      success: true,
      data: row
        ? {
            id: row.id.toString(),
            status: row.status,
            attempts: row.attempts,
            maxAttempts: row.maxAttempts,
            lastError: row.lastError,
            runAt: row.runAt.toISOString(),
            finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
          }
        : null,
    };
  }

  @Post('dev/cancel')
  @ApiOperation({ summary: 'Дев-полигон: отменить живой тест-джоб по uniqueKey' })
  async devCancel(@Body() body: unknown) {
    this.assertDev();
    const { uniqueKey } = devKeySchema.parse(body ?? {});
    const cancelled = await this.jobs.cancelByUniqueKey(null, DEV_ECHO_TYPE, uniqueKey);
    return { success: true, data: { cancelled } };
  }

  @Post('dev/expire-lease')
  @ApiOperation({ summary: 'Дев-полигон: протушить аренду executing-джоба (сценарий краха для reaper)' })
  async devExpireLease(@Body() body: unknown) {
    this.assertDev();
    const { uniqueKey } = devKeySchema.parse(body ?? {});
    const res = await this.db.job.updateMany({
      where: { type: DEV_ECHO_TYPE, uniqueKey, status: 'executing' },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    return { success: true, data: { expired: res.count } };
  }

  @Post('dev/reap')
  @ApiOperation({ summary: 'Дев-полигон: прогнать reaper немедленно' })
  async devReap() {
    this.assertDev();
    await this.jobs.reapExpired();
    return { success: true, data: { ok: true } };
  }
}
