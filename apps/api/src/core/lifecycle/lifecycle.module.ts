import { Global, Logger, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { LIFECYCLE_PENDING_KEYS, LIFECYCLE_POLICY_IDS, lifecycleRegistrationKeys, lifecycleRegistryProblems } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobsService } from '../jobs/jobs.service';
import { LifecycleCron } from './lifecycle.cron';
import { LifecycleDevController } from './lifecycle.dev.controller';
import { LifecycleHealth } from './lifecycle.health';
import { LifecycleLooseFk } from './lifecycle.loose-fk';
import { LifecycleMetrics } from './lifecycle.metrics';
import { LifecyclePartitions } from './lifecycle.partitions';
import { LifecyclePlatformProvider } from './lifecycle.platform.provider';
import { LifecyclePurgeRunner } from './lifecycle.purge';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry } from './lifecycle.purge.registry';
import { LifecycleRuns } from './lifecycle.runs';
import { LifecycleSettings } from './lifecycle.settings';
import { LifecycleTenantPurgeService } from './lifecycle.tenant-purge';

/**
 * core/lifecycle — 28-й платформенный движок: жизненный цикл данных. Один реестр политик на
 * ВСЕ хранилища (модели, сырые таблицы, байты файлов, семейства Redis, архивы и бэкапы) —
 * `packages/shared/src/lifecycle`: чьи это данные, сколько хранить и почему, что делать при
 * стирании человека и при удалении организации, граф удаления, способ принуждения.
 * @Global: модули регистрируют свои шаги purge (`LifecyclePurgeHandlerRegistry`), хуки
 * каскада организации (`LifecycleTenantHookRegistry`), а движки-владельцы журналов — свой
 * срок партиций (`LifecyclePartitions.register`); движок фичи не импортирует — граница
 * держится `check:docs`.
 *
 * Принуждение сроков — раннер `LifecyclePurgeRunner` (джоб на политику, окно, здоровье, AIMD,
 * кэп радиуса); каскад организации — `LifecycleTenantPurgeService` по плану реестра; строки
 * без внешних ключей — `LifecycleLooseFk`; партиции журналов — `LifecyclePartitions`.
 *
 * Смоук на бутстрапе: реестр нарушает правила (длительность не сутками, «по закону» без
 * нормы, hold выключен у юридических записей, хранилище недостижимо от корней графа
 * удаления, цикл в каскаде организации) или объявленный в нём шаг/хук не зарегистрирован
 * модулем — старт падает. docs/lifecycle_engine.md.
 */
@Global()
@Module({
  controllers: [LifecycleDevController],
  providers: [
    LifecycleMetrics,
    LifecyclePartitions,
    LifecycleHealth,
    LifecycleRuns,
    LifecycleSettings,
    LifecyclePurgeHandlerRegistry,
    LifecycleTenantHookRegistry,
    LifecyclePurgeRunner,
    LifecycleTenantPurgeService,
    LifecycleLooseFk,
    LifecycleCron,
    LifecyclePlatformProvider,
  ],
  exports: [LifecyclePartitions, LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry, LifecycleTenantPurgeService, LifecyclePurgeRunner, LifecycleRuns, LifecycleSettings],
})
export class LifecycleModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(LifecycleModule.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    // Терминальные строки очереди (политика Job): движок джобов не зависит от lifecycle — шаг ставит движок сроков
    this.handlers.register('jobs.terminal', {
      purgeBatch: (ctx) => this.jobs.pruneTerminalBatch(ctx.limit),
      estimate: () => this.jobs.countTerminalDue(),
    });
    // Выгрузки организации (Э6) уходят с ней: строки заявок; байты — файлы организации (files.owned)
    this.tenantHooks.register('lifecycle.exports', {
      purge: async (workspaceId) => {
        const { count } = await this.db.lifecycleExport.deleteMany({ where: { subjectType: 'workspace', subjectId: workspaceId } });
        return { rows: count };
      },
      estimate: (workspaceId) => this.db.lifecycleExport.count({ where: { subjectType: 'workspace', subjectId: workspaceId } }),
    });
  }

  onApplicationBootstrap(): void {
    const problems = lifecycleRegistryProblems();
    // Каждый шаг purge и хук каскада из реестра зарегистрирован модулем (кроме ждущих этапа):
    // иначе раннер молча пропускал бы политику, а каскад организации вставал бы на полпути
    const { handlers, hooks } = lifecycleRegistrationKeys();
    for (const k of handlers) if (!LIFECYCLE_PENDING_KEYS[k] && !this.handlers.get(k)) problems.push(`purge handler "${k}" is declared in the registry but not registered (LifecyclePurgeHandlerRegistry)`);
    for (const k of hooks) if (!(LIFECYCLE_PENDING_KEYS[k]?.as === 'hook') && !this.tenantHooks.get(k)) problems.push(`tenant purge hook "${k}" is declared in the registry but not registered (LifecycleTenantHookRegistry)`);
    if (problems.length) {
      const msg = `lifecycle registry is invalid:\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    this.logger.log(`lifecycle registry: ${LIFECYCLE_POLICY_IDS.length} policies, ${handlers.length} purge handlers, ${hooks.length} tenant hooks`);
  }
}
