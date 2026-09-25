import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';

/** Месяц партиции журнала. */
export interface AuditPartitionInfo {
  name: string;
  from: Date;
  to: Date;
}

const NAME_RE = /^security_events_(\d{4})_(\d{2})$/;
/** Замок родителя внутри функции — 2 с (атрибут); повторы с бэкоффом, потом отказ вызывающему. */
const LOCK_RETRIES = 5;

/**
 * Месячные партиции `security_events`. В отличие от прочих журналов (`LifecyclePartitions`)
 * DDL исполняет SECURITY DEFINER-функция владельца ЖУРНАЛА (`audit_ensure_partition` /
 * `audit_drop_partition`): партиция принадлежит владельцу, роль приложения не может отключить её
 * триггер, `TRUNCATE`/`DROP` её или сбросить не выгруженный в архив месяц (docs/audit_engine.md,
 * `scripts/db-roles.sql`). Машина состояний — та же, что у движка сроков: лист = CHECK границ +
 * ATTACH (не ACCESS EXCLUSIVE на родителя — запись аудита идёт в транзакции каждого факта),
 * `lock_timeout 2 с` в функции и повторы с бэкоффом здесь.
 */
@Injectable()
export class AuditPartitions implements OnModuleInit {
  private readonly logger = new Logger(AuditPartitions.name);
  private readonly known = new Set<string>();

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureAhead();
    } catch (err) {
      this.logger.error(`security_events partitions: ${(err as Error).message}`);
    }
  }

  /** Партиция месяца момента `at` (идемпотентно; кэш имён на процесс). */
  async ensureFor(at: Date): Promise<void> {
    const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const name = `security_events_${month.slice(0, 4)}_${month.slice(5, 7)}`;
    if (this.known.has(name)) return;
    await this.withLockRetry(() => this.db.$queryRaw`SELECT audit_ensure_partition(${month}::date) AS name`);
    this.known.add(name);
  }

  /** Текущий месяц и `months - 1` следующих. */
  async ensureAhead(months = 3): Promise<void> {
    const now = new Date();
    for (let i = 0; i < months; i++) await this.ensureFor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)));
  }

  async list(): Promise<AuditPartitionInfo[]> {
    const rows = await this.db.$queryRaw<Array<{ name: string }>>`
      SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'security_events' ORDER BY c.relname`;
    const out: AuditPartitionInfo[] = [];
    for (const r of rows) {
      const m = NAME_RE.exec(r.name);
      if (!m) continue;
      const year = Number(m[1]);
      const month = Number(m[2]);
      out.push({ name: r.name, from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) });
    }
    return out;
  }

  /** Сбросить выгруженную партицию (функция владельца сама проверит архив и возраст ≥ 3 лет). */
  async drop(name: string): Promise<boolean> {
    if (!NAME_RE.test(name)) throw new Error(`audit partitions: not a security_events partition: ${name}`);
    const rows = await this.withLockRetry(() => this.db.$queryRaw<Array<{ dropped: boolean }>>`SELECT audit_drop_partition(${name}) AS dropped`);
    this.known.delete(name);
    return rows[0]?.dropped ?? false;
  }

  /** Ошибка «no partition of relation» — месяц не заведён (крон не успел). */
  static isMissingPartition(err: unknown): boolean {
    return /no partition of relation/i.test(err instanceof Error ? err.message : String(err));
  }

  /** Замок родителя не дался за 2 с (долгое чтение журнала) — повтор с бэкоффом, потом отказ. */
  private async withLockRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (!/lock timeout|55P03|could not obtain lock/i.test(text) || attempt >= LOCK_RETRIES) throw err;
        this.logger.warn(`security_events partition DDL waits for a lock (attempt ${attempt}/${LOCK_RETRIES})`);
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.floor(Math.random() * 200)));
      }
    }
  }
}
