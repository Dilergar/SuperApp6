import { Injectable } from '@nestjs/common';

/** Итог одной проверки готовности: `warn` — деградация (готов), `fail` — не готов, если проверка критична. */
export interface HealthCheckResult {
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  /** Только коды и числа — детали отдаются лишь держателю METRICS_TOKEN */
  detail?: Record<string, string | number | boolean | null | undefined>;
}

export interface HealthCheck {
  /**
   * Критична для ЭТОГО инстанса: провал снимает его с балансировщика (503). Критичны только
   * собственные соединения процесса (база, Redis-состояние). Общие беды (бэкап устарел,
   * партиций мало, кэш лёг) — `warn`/`fail` без 503: снять все инстансы = авария хуже беды;
   * о них кричат метрики и алерты.
   */
  critical: boolean;
  /** Потолок проверки, мс (по умолчанию 2000): висящая зависимость = провал, а не висящая проба */
  timeoutMs?: number;
  run(): Promise<HealthCheckResult>;
}

/**
 * Реестр проверок готовности (`GET /health/ready`). Ядро регистрирует базу и Redis; движки —
 * свои (core/lifecycle: партиции вперёд, свежесть бэкапов). `shared` не знает о движках —
 * обратное направление только через реестр (правило платформы).
 */
@Injectable()
export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheck>();

  register(name: string, check: HealthCheck): void {
    if (this.checks.has(name)) throw new Error(`health check "${name}" is already registered`);
    this.checks.set(name, check);
  }

  entries(): Array<[string, HealthCheck]> {
    return [...this.checks.entries()];
  }
}
