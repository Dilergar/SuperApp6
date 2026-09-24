import { Global, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { LIFECYCLE_POLICY_IDS, lifecycleRegistryProblems } from '@superapp/shared';
import { LifecycleCron } from './lifecycle.cron';
import { LifecycleDevController } from './lifecycle.dev.controller';
import { LifecycleMetrics } from './lifecycle.metrics';
import { LifecyclePartitions } from './lifecycle.partitions';

/**
 * core/lifecycle — 28-й платформенный движок: жизненный цикл данных. Один реестр политик на
 * ВСЕ хранилища (модели, сырые таблицы, байты файлов, семейства Redis, архивы и бэкапы) —
 * `packages/shared/src/lifecycle`: чьи это данные, сколько хранить и почему, что делать при
 * стирании человека и при удалении организации, граф удаления, способ принуждения.
 * @Global: модули регистрируют свои шаги purge, хуки удаления организации и стирания, а
 * движки-владельцы журналов — свой срок партиций (`LifecyclePartitions.register`); движок
 * фичи не импортирует — граница держится `check:docs`.
 *
 * Партиции всех журналов — `LifecyclePartitions` (функции владельца в БД, миграция
 * `core_lifecycle`); ночное обслуживание — `LifecycleCron`.
 *
 * Смоук на бутстрапе: реестр нарушает правила (длительность не сутками, «по закону» без
 * нормы, hold выключен у юридических записей, хранилище недостижимо от корней графа
 * удаления, доказательство не в журнале) — старт падает. docs/lifecycle_engine.md.
 */
@Global()
@Module({
  controllers: [LifecycleDevController],
  providers: [LifecycleMetrics, LifecyclePartitions, LifecycleCron],
  exports: [LifecyclePartitions],
})
export class LifecycleModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(LifecycleModule.name);

  onApplicationBootstrap(): void {
    const problems = lifecycleRegistryProblems();
    if (problems.length) {
      const msg = `lifecycle registry is invalid:\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    this.logger.log(`lifecycle registry: ${LIFECYCLE_POLICY_IDS.length} policies`);
  }
}
