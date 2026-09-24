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
  @ApiOperation({ summary: 'Jobs engine counters plus the latest dead letters (development only)' })
  async stats() {
    this.assertDev();
    return { success: true, data: await this.jobs.stats() };
  }

  /**
   * Осознанная чистка джобов мёртвого типа. Ручка dev-only: в проде это редкая
   * операция «раз в жизни типа», а её место — будущий кабинет platform_admin
   * (No Placeholder UI). До него в проде — тот же `purgeUnhandled` из консоли/SQL.
   * Тип называется ЯВНО: движок сам не решает, что «незнакомое» = «мёртвое»
   * (чаще это выключенная фича — см. JobsService.listUnhandled).
   */
  @Post('dev/purge-unhandled')
  @ApiOperation({ summary: 'Bury the live jobs of a type that has no handler (development only)' })
  async devPurgeUnhandled(@Body() body: unknown) {
    this.assertDev();
    const { type } = z.object({ type: z.string().min(1).max(100) }).strict().parse(body ?? {});
    return { success: true, data: { purged: await this.jobs.purgeUnhandled(type) } };
  }

  @Post('dev/prune')
  @ApiOperation({ summary: 'Run the retention of terminal jobs now: completed after a day, discarded/cancelled after 30 days (development only)' })
  async devPrune() {
    this.assertDev();
    return { success: true, data: await this.jobs.pruneTerminal() };
  }

  @Post('dev/reindex')
  @ApiOperation({ summary: 'Run the weekly REINDEX CONCURRENTLY of the job queue now (development only)' })
  async devReindex() {
    this.assertDev();
    await this.jobs.reindexQueue();
    return { success: true, data: { reindexed: true } };
  }

  @Post('dev/enqueue')
  @ApiOperation({ summary: 'Dev sandbox: enqueue a test job (inside a transaction; rollback=true rolls it back)' })
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
  @ApiOperation({ summary: 'Dev sandbox: the state of a test job by uniqueKey (the latest row)' })
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
  @ApiOperation({ summary: 'Dev sandbox: cancel a live test job by uniqueKey' })
  async devCancel(@Body() body: unknown) {
    this.assertDev();
    const { uniqueKey } = devKeySchema.parse(body ?? {});
    const cancelled = await this.jobs.cancelByUniqueKey(null, DEV_ECHO_TYPE, uniqueKey);
    return { success: true, data: { cancelled } };
  }

  @Post('dev/expire-lease')
  @ApiOperation({ summary: 'Dev sandbox: expire the lease of an executing job (a crash scenario for the reaper)' })
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
  @ApiOperation({ summary: 'Dev sandbox: run the reaper right now' })
  async devReap() {
    this.assertDev();
    await this.jobs.reapExpired();
    return { success: true, data: { ok: true } };
  }
}
