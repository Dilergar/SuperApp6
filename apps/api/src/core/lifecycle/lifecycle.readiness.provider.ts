import { Injectable, OnModuleInit } from '@nestjs/common';
import { isDevEnv } from '../../shared/config/env.validation';
import { HealthRegistry } from '../../shared/health/health.registry';
import { LifecycleDashboardService } from './lifecycle.dashboard.service';
import { LifecyclePartitions, type LifecyclePartitionHealth } from './lifecycle.partitions';

/** Итог тяжёлой проверки живёт минуту на процесс: пробы идут раз в секунды, каталог — не их забота. */
const CACHE_MS = 60_000;
/** Бэкап без успеха дольше — предупреждение готовности (тот же порог, что у плитки обзора). */
const BACKUP_STALE_MS = 26 * 3600_000;

/**
 * Проверки готовности движка (`GET /health/ready`, shared/health): партиции журналов вперёд и
 * свежесть бэкапов. Обе НЕкритичны: беда общая для всех инстансов — снять их с балансировщика
 * значит превратить деградацию в аварию; о ней кричат метрики (`lifecycle_partitions_ahead`,
 * `lifecycle_backup_last_success_seconds`) и Кабинет.
 */
@Injectable()
export class LifecycleReadinessProvider implements OnModuleInit {
  private partitionsMemo: { at: number; health: LifecyclePartitionHealth[] } | null = null;

  constructor(
    private readonly registry: HealthRegistry,
    private readonly partitions: LifecyclePartitions,
    private readonly dashboard: LifecycleDashboardService,
  ) {}

  onModuleInit(): void {
    this.registry.register('partitions', {
      critical: false,
      timeoutMs: 3000,
      run: async () => {
        const now = Date.now();
        if (!this.partitionsMemo || now - this.partitionsMemo.at > CACHE_MS) {
          this.partitionsMemo = { at: now, health: await this.partitions.health(new Date(now)) };
        }
        const h = this.partitionsMemo.health;
        const minAhead = h.length ? Math.min(...h.map((x) => x.ahead)) : null;
        // Партиция текущего периода есть не у всех — вставки в журнал упадут
        if (minAhead === null) return { status: 'warn', detail: { parents: 0 } };
        return { status: minAhead < 1 ? 'fail' : minAhead < 2 ? 'warn' : 'ok', detail: { parents: h.length, minAhead } };
      },
    });
    this.registry.register('backups', {
      critical: false,
      timeoutMs: 3000,
      run: async () => {
        // В разработке скриптов бэкапа нет — проверка не про неё
        if (isDevEnv()) return { status: 'skipped', detail: { reason: 'development' } };
        const f = await this.dashboard.backupFreshness();
        const last = f.repos.map((r) => (r.lastSuccessAt ? new Date(r.lastSuccessAt).getTime() : 0)).reduce((a, b) => Math.max(a, b), 0);
        const ageHours = last ? Math.floor((Date.now() - last) / 3600_000) : null;
        return { status: last && Date.now() - last <= BACKUP_STALE_MS ? 'ok' : 'warn', detail: { ageHours, repos: f.repos.length } };
      },
    });
  }
}
