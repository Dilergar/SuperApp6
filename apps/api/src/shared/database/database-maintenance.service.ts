import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { maintenanceDatabaseUrl } from './database-url';

/**
 * Обслуживающее подключение к базе (docs/data_architecture.md): прямое (мимо PgBouncer), два
 * соединения, таймауты роли приложения сняты параметрами запуска. Только для законно долгих
 * операций обслуживания — REINDEX CONCURRENTLY очереди джобов, суточный роллап аналитики.
 * Клиент голый (без расширений ПДн и организации): сюда ходит только сырой SQL служебных
 * таблиц, никогда — чтение данных людей.
 */
@Injectable()
export class DatabaseMaintenance implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseMaintenance.name);
  private client: PrismaClient | null = null;

  get db(): PrismaClient {
    if (!this.client) {
      this.client = new PrismaClient({ datasourceUrl: maintenanceDatabaseUrl(), log: ['error'] });
      this.logger.log('maintenance connection opened (direct, role timeouts lifted)');
    }
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}
