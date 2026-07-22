import { Global, Logger, Module } from '@nestjs/common';
import {
  DatabaseService,
  buildScopedPrismaClient,
} from './database.service';
import { WorkspaceContextService } from '../context/workspace-context.service';

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
        `Часовой пояс сессии БД = "${tz}", а не UTC. Колонки времени — timestamp без пояса; ` +
          `сырой SQL со временем разъедется на смещение пояса. Почините сервер БД ` +
          `(timezone=UTC в postgresql.conf) или добавьте в DATABASE_URL "?options=-c%20timezone%3DUTC".`,
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
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
