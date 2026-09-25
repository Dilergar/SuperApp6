import { Global, Logger, Module } from '@nestjs/common';
import {
  DatabaseService,
  buildScopedPrismaClient,
} from './database.service';
import { WorkspaceContextService } from '../context/workspace-context.service';
import { DatabaseMaintenance } from './database-maintenance.service';

/**
 * Страж часового пояса сессии БД. Все колонки времени — `timestamp` БЕЗ пояса, и
 * Prisma хранит в них UTC. Сырой SQL, где такая колонка встречается с `now()` или с
 * параметром-Date (тип `timestamptz`), Postgres доворачивает ПОЯСОМ СЕССИИ — при
 * TimeZone ≠ UTC значения молча разъезжаются на смещение пояса (у нас +05).
 * Движок джобов от этого защищён явными `AT TIME ZONE 'UTC'` в своих запросах, но
 * прочие сайты (окна продаж скинов, время уведомлений) полагаются на UTC-сессию.
 * Дешевле один громкий варн на старте, чем ночной разбор «почему всё на 5ч не то».
 */
async function assertUtcSession(
  // Именно расширенный ($extends) клиент фабрики, а не голый DatabaseService.
  client: ReturnType<typeof buildScopedPrismaClient>,
  logger: Logger,
): Promise<void> {
  try {
    const rows = await client.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
    const tz = rows[0]?.tz;
    if (tz && tz !== 'UTC') {
      logger.warn(
        `The database session time zone is "${tz}", not UTC. Time columns are timestamps without a zone; ` +
          `raw SQL over time would drift by the zone offset. Fix the database server ` +
          `(timezone=UTC in postgresql.conf) or add "?options=-c%20timezone%3DUTC" to DATABASE_URL.`,
      );
    }
  } catch {
    // Проверка диагностическая — её сбой не должен мешать старту приложения.
  }
}

/**
 * Provides DatabaseService as a workspace-scoped (chokepoint) Prisma client.
 * The factory connects on startup; the WorkspaceContextService it depends on comes
 * from the @Global WorkspaceContextModule.
 */
@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      inject: [WorkspaceContextService],
      useFactory: async (wsContext: WorkspaceContextService) => {
        const client = buildScopedPrismaClient(wsContext);
        await client.$connect();
        await assertUtcSession(client, new Logger(DatabaseModule.name));
        return client;
      },
    },
    DatabaseMaintenance,
  ],
  exports: [DatabaseService, DatabaseMaintenance],
})
export class DatabaseModule {}
