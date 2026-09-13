import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { ANALYTICS_ERROR_CODES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { unprocessable } from '../../shared/errors/api-error';
import { analyticsEnv } from './analytics.constants';

/**
 * Клиент чтения отчётов Кабинета. `ANALYTICS_READ_DATABASE_URL` задан → отдельный пул
 * (реплика или роль `analytics_reader` только на чтение), иначе основной. Каждый
 * запрос — в транзакции `READ ONLY` с `SET LOCAL statement_timeout`: тяжёлая воронка не
 * держит соединение дольше потолка и физически не может ничего записать.
 */
@Injectable()
export class AnalyticsReadDb implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsReadDb.name);
  private client: PrismaClient | null = null;

  constructor(private readonly db: DatabaseService) {}

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }

  private reader(): PrismaClient {
    const url = analyticsEnv().readDatabaseUrl;
    if (!url) return this.db;
    if (!this.client) {
      this.client = new PrismaClient({ datasourceUrl: url, log: ['error'] });
      this.logger.log('analytics reports read through ANALYTICS_READ_DATABASE_URL');
    }
    return this.client;
  }

  async query<T>(sql: Prisma.Sql, timeoutMs = analyticsEnv().queryTimeoutMs): Promise<T[]> {
    const ms = Math.max(500, Math.floor(timeoutMs));
    try {
      return await this.reader().$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
          return tx.$queryRaw<T[]>(sql);
        },
        { timeout: ms + 5_000, maxWait: 5_000 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/statement timeout|57014/i.test(msg)) {
        throw unprocessable('analytics.query_timeout', undefined, { code: ANALYTICS_ERROR_CODES.queryTimeout });
      }
      throw err;
    }
  }
}
