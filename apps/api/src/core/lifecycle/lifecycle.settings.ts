import { Injectable } from '@nestjs/common';
import { LIFECYCLE_FOREVER, resolveLifecycleRetention, type LifecyclePolicy } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';

/** Потолок строк настроек за чтение (организаций с настроенным классом данных). */
const MAX_SETTINGS = 10_000;

/**
 * Сроки, выбранные организациями (`lifecycle_settings`: организация × класс данных), глазами
 * принуждения. Отложенное сокращение (`pending*`) действует с момента вступления — чтение
 * учитывает его само, отдельной «сверки» принуждение не ждёт. Срок проходит через тот же
 * разрешитель, что UI и отчёт (`resolveLifecycleRetention`): пол закона и потолок политики
 * срезают выбор организации. Потолок ТАРИФА (`entitlementKey`) применяет запись настройки
 * (коридор при сохранении, Э5): в строке не может оказаться значения вне коридора.
 */
@Injectable()
export class LifecycleSettings {
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
      const pendingActive = r.pendingSet && r.pendingEffectiveAt !== null && r.pendingEffectiveAt.getTime() <= now.getTime();
      const raw = pendingActive ? r.pendingDays : r.days;
      const { days } = resolveLifecycleRetention({ policy, tenantDays: raw === null ? LIFECYCLE_FOREVER : raw });
      if (typeof days === 'number' && days > 0) out.push({ workspaceId: r.workspaceId, days });
    }
    return out;
  }
}
