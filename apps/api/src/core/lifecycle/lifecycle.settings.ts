import { Injectable } from '@nestjs/common';
import {
  LIFECYCLE_FOREVER,
  LIFECYCLE_POLICY_IDS,
  LIFECYCLE_TENANT_CLASSES,
  lifecyclePolicy,
  resolveLifecycleRetention,
  type LifecycleDuration,
  type LifecyclePolicy,
  type LifecycleTenantClass,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';

/** Потолок строк настроек за чтение (организаций с настроенным классом данных). */
const MAX_SETTINGS = 10_000;
/** Сколько живёт выбор организации в памяти процесса (чтение режет по нему на каждом запросе). */
const CHOICE_TTL_MS = 60_000;
const CHOICE_CACHE_MAX = 5_000;
const DAY_MS = 86_400_000;

/** Строка настройки: выбранный срок и отложенное сокращение. */
interface SettingRow {
  days: number | null;
  pendingSet: boolean;
  pendingDays: number | null;
  pendingEffectiveAt: Date | null;
}

/** Выбор организации НА МОМЕНТ: отложенное сокращение, чей срок наступил, уже действует. */
export function lifecycleChoiceAt(row: SettingRow, now: Date): LifecycleDuration {
  const pendingActive = row.pendingSet && row.pendingEffectiveAt !== null && row.pendingEffectiveAt.getTime() <= now.getTime();
  const raw = pendingActive ? row.pendingDays : row.days;
  return raw === null ? LIFECYCLE_FOREVER : raw;
}

/** Политики класса, чей срок выбирает организация. */
export function lifecycleTenantPolicies(dataClass: LifecycleTenantClass): LifecyclePolicy[] {
  return LIFECYCLE_POLICY_IDS.map((id) => lifecyclePolicy(id)!).filter((p) => p.dataClass === dataClass && !!p.retention.tenantConfigurable);
}

/**
 * Сроки, выбранные организациями (`lifecycle_settings`: организация × класс данных), глазами
 * принуждения. Отложенное сокращение (`pending*`) действует с момента вступления — чтение
 * учитывает его само, отдельной «сверки» принуждение не ждёт. Срок проходит через тот же
 * разрешитель, что UI и отчёт (`resolveLifecycleRetention`): пол закона и потолок политики
 * срезают выбор организации. Потолок ТАРИФА применяет запись настройки (коридор при
 * сохранении): в строке не может оказаться значения вне коридора, а смена тарифа молча
 * данных не удаляет.
 *
 * Одна правда для раннера (удаление), чтения (строки старше срока не показываются сразу —
 * purge лишь освобождает место) и страницы организации.
 */
@Injectable()
export class LifecycleSettings {
  private readonly choices = new Map<string, { at: number; value: LifecycleDuration | null }>();

  constructor(private readonly db: DatabaseService) {}

  /** Организации с КОНЕЧНЫМ действующим сроком по политике (по возрастанию id). */
  async tenantRetentions(policy: LifecyclePolicy, now = new Date()): Promise<Array<{ workspaceId: string; days: number }>> {
    if (!policy.retention.tenantConfigurable) return [];
    const rows = await this.db.lifecycleSetting.findMany({
      where: { dataClass: policy.dataClass },
      select: { workspaceId: true, days: true, pendingSet: true, pendingDays: true, pendingEffectiveAt: true },
      orderBy: { workspaceId: 'asc' },
      take: MAX_SETTINGS,
    });
    const out: Array<{ workspaceId: string; days: number }> = [];
    for (const r of rows) {
      const { days } = resolveLifecycleRetention({ policy, tenantDays: lifecycleChoiceAt(r, now) });
      if (typeof days === 'number' && days > 0) out.push({ workspaceId: r.workspaceId, days });
    }
    return out;
  }

  /**
   * Выбор организации для класса на сейчас (`null` — не выбирала: действует умолчание
   * реестра). Кэш минуту в процессе: чтение ленты и хроники зовёт это на каждом запросе.
   */
  async tenantChoice(workspaceId: string, dataClass: LifecycleTenantClass): Promise<LifecycleDuration | null> {
    const key = `${workspaceId}:${dataClass}`;
    const now = Date.now();
    const hit = this.choices.get(key);
    if (hit && now - hit.at < CHOICE_TTL_MS) return hit.value;
    const row = await this.db.lifecycleSetting.findUnique({
      where: { workspaceId_dataClass: { workspaceId, dataClass } },
      select: { days: true, pendingSet: true, pendingDays: true, pendingEffectiveAt: true },
    });
    const value = row ? lifecycleChoiceAt(row, new Date(now)) : null;
    if (this.choices.size >= CHOICE_CACHE_MAX) this.choices.clear();
    this.choices.set(key, { at: now, value });
    return value;
  }

  /** Действующий срок политики у организации (выбор × пол × потолок политики); `'forever'` — хранится вечно. */
  async effectiveFor(policy: LifecyclePolicy, workspaceId: string): Promise<LifecycleDuration> {
    const choice = policy.retention.tenantConfigurable ? await this.tenantChoice(workspaceId, policy.dataClass as LifecycleTenantClass) : null;
    const { days } = resolveLifecycleRetention({ policy, tenantDays: choice ?? undefined });
    return days === 0 ? 1 : days;
  }

  /**
   * Граница чтения политики у организации: строки с временем старше — уже вне срока и не
   * показываются (правило принуждения при чтении). `null` — срок вечен, границы нет.
   */
  async readCutoff(policy: LifecyclePolicy, workspaceId: string, now = new Date()): Promise<Date | null> {
    const days = await this.effectiveFor(policy, workspaceId);
    return days === LIFECYCLE_FOREVER ? null : new Date(now.getTime() - days * DAY_MS);
  }

  /** Сбросить кэш выбора организации (после сохранения — у этого процесса сразу, у соседних ≤ минуты). */
  invalidate(workspaceId: string): void {
    for (const cls of LIFECYCLE_TENANT_CLASSES) this.choices.delete(`${workspaceId}:${cls}`);
  }
}
