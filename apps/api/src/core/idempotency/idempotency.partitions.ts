import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { runInternal } from '../../shared/idempotency/binding';
import { idempotencyEnv } from './idempotency.constants';

const PARTITION_RE = /^responses_(\d{4})_(\d{2})_(\d{2})$/;

/** Имя дневной партиции из валидированных чисел — единственное, что уходит в DDL. */
const partitionName = (y: number, m: number, d: number) =>
  `responses_${y}_${String(m).padStart(2, '0')}_${String(d).padStart(2, '0')}`;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Партиции снимков `idem.responses` (день, границы UTC). Снимок живёт часы, а не
 * годы, поэтому ретенция — не DELETE миллионов строк, а `DETACH … CONCURRENTLY` +
 * `DROP` партиции целиком (приём `core/analytics`).
 *
 * НЕТ партиции = «тела нет»: вставка снимка молча пропускается, запрос НЕ падает.
 * Идемпотентность защищает эффект, а не возможность показать тело второй раз.
 */
@Injectable()
export class IdempotencyPartitions {
  private readonly logger = new Logger(IdempotencyPartitions.name);
  /** Партиции, уже подтверждённые этим инстансом */
  private readonly known = new Set<string>();

  constructor(private readonly db: DatabaseService) {}

  /** Партиция дня момента `at` (идемпотентно). */
  async ensureFor(at: Date): Promise<void> {
    const y = at.getUTCFullYear();
    const m = at.getUTCMonth() + 1;
    const d = at.getUTCDate();
    const name = partitionName(y, m, d);
    if (this.known.has(name)) return;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const lo = `${y}-${pad(m)}-${pad(d)} 00:00:00`;
    const hi = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())} 00:00:00`;
    await runInternal(async () => {
      await this.db.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS idem.${name} PARTITION OF idem.responses FOR VALUES FROM ('${lo}') TO ('${hi}')`,
      );
      await this.db.$executeRawUnsafe(
        `ALTER TABLE idem.${name} SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05)`,
      );
    });
    this.known.add(name);
  }

  /** Сегодня и два следующих дня (крон мог не сработать — бут доделывает). */
  async ensureAhead(): Promise<void> {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await this.ensureFor(new Date(now + i * 86_400_000));
  }

  async list(): Promise<Array<{ name: string; to: Date }>> {
    const rows = await runInternal(() =>
      this.db.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT c.relname AS name
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
         WHERE n.nspname = 'idem' AND p.relname = 'responses'
         ORDER BY c.relname`,
      ),
    );
    const out: Array<{ name: string; to: Date }> = [];
    for (const r of rows) {
      const m = PARTITION_RE.exec(r.name);
      if (!m) continue;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      out.push({ name: partitionName(y, mo, d), to: new Date(Date.UTC(y, mo - 1, d + 1)) });
    }
    return out;
  }

  /**
   * Сбросить партиции, чья ВЕРХНЯЯ граница старше окна снимка. Возвращает имена.
   *
   * Каждая партиция — СВОЯ попытка: сбой на одной не вправе остановить остальные и всё,
   * что идёт в ночной уборке следом. `DETACH … CONCURRENTLY`, оборванный на полпути
   * (рестарт, отмена), оставляет партицию в состоянии «detach pending», и повторный
   * DETACH на ней падает КАЖДУЮ ночь — без `FINALIZE` ретенция встала бы навсегда.
   */
  async dropExpired(now = new Date()): Promise<string[]> {
    const cutoff = now.getTime() - idempotencyEnv().responseTtlHours * 3_600_000;
    const dropped: string[] = [];
    for (const p of await this.list()) {
      if (p.to.getTime() > cutoff) continue;
      try {
        await runInternal(async () => {
          try {
            // CONCURRENTLY не держит эксклюзивный лок на родителе — вставки идут дальше
            await this.db.$executeRawUnsafe(`ALTER TABLE idem.responses DETACH PARTITION idem.${p.name} CONCURRENTLY`);
          } catch {
            // Прошлый DETACH оборвался — доводим его до конца
            await this.db.$executeRawUnsafe(`ALTER TABLE idem.responses DETACH PARTITION idem.${p.name} FINALIZE`);
          }
          await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS idem.${p.name}`);
        });
      } catch (err) {
        this.logger.error(
          `idempotency response partition ${p.name} was not dropped: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      this.known.delete(p.name);
      dropped.push(p.name);
      this.logger.log(`idempotency response partition dropped by retention: ${p.name}`);
    }
    return dropped;
  }
}
