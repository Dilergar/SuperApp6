import { Logger } from '@nestjs/common';
import type { DatabaseService } from './database.service';

/** Таблица-родитель, партиционированная `PARTITION BY RANGE (<column>)` по месяцам (UTC). */
export interface MonthlyPartitionSpec {
  /** Имя родителя (без схемы) — оно же префикс партиций `<table>_YYYY_MM` */
  table: string;
  /** Колонка партиционирования (`timestamp`) */
  column: string;
  /** Сколько дней держать: партиция сбрасывается, когда её ВЕРХНЯЯ граница старше */
  retentionDays: number;
  /** Схема PostgreSQL (по умолчанию `public`) */
  schema?: string;
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Месячные партиции журналов (прецедент `analytics.events`): создание на месяцы вперёд,
 * ретеншн — `DETACH … CONCURRENTLY` + `DROP` целой партиции вместо `DELETE` миллионов
 * строк. DDL собирается только из имён спецификации (проверены регулярным выражением)
 * и чисел года/месяца — пользовательский ввод сюда не попадает. `$executeRawUnsafe`
 * исполняется вне транзакции: `DETACH … CONCURRENTLY` внутри неё невозможен.
 */
export class MonthlyPartitions {
  private readonly logger: Logger;
  private readonly known = new Set<string>();
  private readonly schema: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly spec: MonthlyPartitionSpec,
  ) {
    this.schema = spec.schema ?? 'public';
    for (const ident of [spec.table, spec.column, this.schema]) {
      if (!SAFE_IDENT.test(ident)) throw new Error(`monthly partitions: unsafe identifier "${ident}"`);
    }
    this.logger = new Logger(`Partitions:${spec.table}`);
  }

  private name(year: number, month: number): string {
    return `${this.spec.table}_${year}_${String(month).padStart(2, '0')}`;
  }

  private get pattern(): RegExp {
    return new RegExp(`^${this.spec.table}_(\\d{4})_(\\d{2})$`);
  }

  /** Партиция месяца момента `at` (идемпотентно). Границы — timestamp без зоны, UTC-месяц. */
  async ensureFor(at: Date): Promise<void> {
    const year = at.getUTCFullYear();
    const month = at.getUTCMonth() + 1;
    const name = this.name(year, month);
    if (this.known.has(name)) return;
    const lo = `${year}-${String(month).padStart(2, '0')}-01 00:00:00`;
    const next = new Date(Date.UTC(year, month, 1));
    const hi = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00`;
    await this.db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${this.schema}"."${name}" PARTITION OF "${this.schema}"."${this.spec.table}" FOR VALUES FROM ('${lo}') TO ('${hi}')`,
    );
    // Журнал только растёт вставками: автовакуум по объёму вставок, а не по доле изменённых строк
    await this.db.$executeRawUnsafe(
      `ALTER TABLE "${this.schema}"."${name}" SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)`,
    );
    this.known.add(name);
  }

  /** Текущий месяц и `months - 1` следующих. */
  async ensureAhead(months = 3): Promise<void> {
    const now = new Date();
    for (let i = 0; i < months; i++) await this.ensureFor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)));
  }

  async list(): Promise<Array<{ name: string; from: Date; to: Date }>> {
    const rows = await this.db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT c.relname AS name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = $1 AND p.relname = $2
       ORDER BY c.relname`,
      this.schema,
      this.spec.table,
    );
    const out: Array<{ name: string; from: Date; to: Date }> = [];
    for (const r of rows) {
      const m = this.pattern.exec(r.name);
      if (!m) continue;
      const year = Number(m[1]);
      const month = Number(m[2]);
      out.push({ name: this.name(year, month), from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) });
    }
    return out;
  }

  /** Сбросить партиции, чья ВЕРХНЯЯ граница старше ретенции. Возвращает имена сброшенных. */
  async dropExpired(now = new Date()): Promise<string[]> {
    const cutoff = now.getTime() - this.spec.retentionDays * 86_400_000;
    const dropped: string[] = [];
    for (const p of await this.list()) {
      if (p.to.getTime() > cutoff) continue;
      await this.db.$executeRawUnsafe(`ALTER TABLE "${this.schema}"."${this.spec.table}" DETACH PARTITION "${this.schema}"."${p.name}" CONCURRENTLY`);
      await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${this.schema}"."${p.name}"`);
      this.known.delete(p.name);
      dropped.push(p.name);
      this.logger.log(`partition dropped by retention: ${p.name}`);
    }
    return dropped;
  }

  /** Ошибка «no partition of relation» — месяц не заведён (крон не успел): завести и повторить один раз. */
  static isMissingPartition(err: unknown): boolean {
    return /no partition of relation/i.test(err instanceof Error ? err.message : String(err));
  }
}
