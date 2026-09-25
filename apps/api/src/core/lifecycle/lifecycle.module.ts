import { Global, Logger, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { LIFECYCLE_PENDING_KEYS, LIFECYCLE_POLICY_IDS, lifecyclePolicy, lifecycleRegistrationKeys, lifecycleRegistryProblems } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobsService } from '../jobs/jobs.service';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleCron } from './lifecycle.cron';
import { LifecycleDevController } from './lifecycle.dev.controller';
import { LifecycleHealth } from './lifecycle.health';
import { LifecycleLooseFk } from './lifecycle.loose-fk';
import { LifecycleMetrics } from './lifecycle.metrics';
import { LifecyclePartitions } from './lifecycle.partitions';
import { LifecyclePlatformProvider } from './lifecycle.platform.provider';
import { LifecyclePurgeRunner } from './lifecycle.purge';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleCanaryService } from './lifecycle.canary';
import { LifecycleCanaryRegistry, LifecyclePurgeHandlerRegistry, LifecycleSubjectHookRegistry, LifecycleTenantHookRegistry } from './lifecycle.purge.registry';
import { LifecycleRuns } from './lifecycle.runs';
import { LifecycleSettings } from './lifecycle.settings';
import { LifecycleOverrides } from './lifecycle.overrides';
import { LifecycleDashboardService } from './lifecycle.dashboard.service';
import { LifecycleDashboardController, LifecycleOpsController } from './lifecycle.dashboard.controller';
import { LifecycleExportCollector } from './lifecycle.export.collector';
import { LifecycleExportController } from './lifecycle.export.controller';
import { LifecycleExportRegistry } from './lifecycle.export.registry';
import { LifecycleExportService } from './lifecycle.export.service';
import { LifecycleRestoreService } from './lifecycle.restore.service';
import { LifecycleSettingsService } from './lifecycle.settings.service';
import { LifecycleTenantPurgeService } from './lifecycle.tenant-purge';
import { lifecycleTableOf, lifecycleTenantScopeSql } from './lifecycle.sql';

/**
 * core/lifecycle — 28-й платформенный движок: жизненный цикл данных. Один реестр политик на
 * ВСЕ хранилища (модели, сырые таблицы, байты файлов, семейства Redis, архивы и бэкапы) —
 * `packages/shared/src/lifecycle`: чьи это данные, сколько хранить и почему, что делать при
 * стирании человека и при удалении организации, граф удаления, способ принуждения.
 * @Global: модули регистрируют свои шаги purge (`LifecyclePurgeHandlerRegistry`), хуки
 * каскада организации (`LifecycleTenantHookRegistry`), шаги стирания человека
 * (`LifecycleSubjectHookRegistry`) и посев канарейки рядом с ним (`LifecycleCanaryRegistry`),
 * а движки-владельцы журналов — свой
 * срок партиций (`LifecyclePartitions.register`); движок фичи не импортирует — граница
 * держится `check:docs`.
 *
 * Принуждение сроков — раннер `LifecyclePurgeRunner` (джоб на политику, окно, здоровье, AIMD,
 * кэп радиуса); каскад организации — `LifecycleTenantPurgeService` по плану реестра; строки
 * без внешних ключей — `LifecycleLooseFk`; партиции журналов — `LifecyclePartitions`; заморозки
 * (legal hold) — `LifecycleHoldsService`; стирание субъекта с журналом, квитанцией и подписанным
 * сертификатом — `LifecycleErasureService`; ночная проверка стирания — `LifecycleCanaryService`.
 *
 * Смоук на бутстрапе: реестр нарушает правила (длительность не сутками, «по закону» без
 * нормы, hold выключен у юридических записей, хранилище недостижимо от корней графа
 * удаления, цикл в каскаде организации) или объявленный в нём шаг/хук не зарегистрирован
 * модулем — старт падает. docs/lifecycle_engine.md.
 */
@Global()
@Module({
  controllers: [LifecycleController, LifecycleExportController, LifecycleDevController, LifecycleDashboardController, LifecycleOpsController],
  providers: [
    LifecycleMetrics,
    LifecyclePartitions,
    LifecycleHealth,
    LifecycleRuns,
    LifecycleSettings,
    LifecycleSettingsService,
    LifecycleOverrides,
    LifecycleDashboardService,
    LifecyclePurgeHandlerRegistry,
    LifecycleTenantHookRegistry,
    LifecycleSubjectHookRegistry,
    LifecycleCanaryRegistry,
    LifecycleExportRegistry,
    LifecycleHoldsService,
    LifecycleErasureService,
    LifecycleExportCollector,
    LifecycleExportService,
    LifecycleRestoreService,
    LifecycleCanaryService,
    LifecyclePurgeRunner,
    LifecycleTenantPurgeService,
    LifecycleLooseFk,
    LifecycleCron,
    LifecyclePlatformProvider,
  ],
  exports: [
    LifecyclePartitions,
    LifecyclePurgeHandlerRegistry,
    LifecycleTenantHookRegistry,
    LifecycleSubjectHookRegistry,
    LifecycleCanaryRegistry,
    LifecycleExportRegistry,
    LifecycleExportService,
    LifecycleTenantPurgeService,
    LifecyclePurgeRunner,
    LifecycleRuns,
    LifecycleSettings,
    LifecycleSettingsService,
    LifecycleOverrides,
    LifecycleDashboardService,
    LifecycleHoldsService,
    LifecycleErasureService,
  ],
})
export class LifecycleModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(LifecycleModule.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly jobs: JobsService,
    private readonly erasure: LifecycleErasureService,
  ) {}

  onModuleInit(): void {
    // Терминальные строки очереди (политика Job): движок джобов не зависит от lifecycle — шаг ставит движок сроков
    this.handlers.register('jobs.terminal', {
      purgeBatch: (ctx) => this.jobs.pruneTerminalBatch(ctx.limit),
      estimate: () => this.jobs.countTerminalDue(),
    });
    // Выгрузки организации уходят с ней: байты частей и манифеста, затем строки заявок
    this.tenantHooks.register('lifecycle.exports', {
      purge: (workspaceId) => this.erasure.deleteExports({ subjectType: 'workspace', subjectId: workspaceId }),
      estimate: (workspaceId) => this.db.lifecycleExport.count({ where: { subjectType: 'workspace', subjectId: workspaceId } }),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const problems = lifecycleRegistryProblems();
    problems.push(...(await this.personIdsProblems()));
    // Срок, выбранный организацией, раннер режет только по условию «строка организации»: без
    // него правило организации срезало бы строки всех — политика без условия (и без своего
    // шага purge) не может быть настраиваемой
    for (const id of LIFECYCLE_POLICY_IDS) {
      const p = lifecyclePolicy(id)!;
      if (!p.retention.tenantConfigurable) continue;
      if (p.enforcement.kind === 'batched_delete' && p.enforcement.handler) continue;
      const table = lifecycleTableOf(p);
      if (!table || !lifecycleTenantScopeSql(p, table, '00000000-0000-0000-0000-000000000000')) problems.push(`${id}: tenantConfigurable, but rows of an organisation cannot be scoped (ownerKey)`);
    }
    // Каждый шаг purge и хук каскада из реестра зарегистрирован модулем (кроме ждущих этапа):
    // иначе раннер молча пропускал бы политику, а каскад организации вставал бы на полпути
    const { handlers, hooks, subjectHooks } = lifecycleRegistrationKeys();
    for (const k of handlers) if (!(LIFECYCLE_PENDING_KEYS[k]?.as === 'handler') && !this.handlers.get(k)) problems.push(`purge handler "${k}" is declared in the registry but not registered (LifecyclePurgeHandlerRegistry)`);
    for (const k of hooks) if (!(LIFECYCLE_PENDING_KEYS[k]?.as === 'hook') && !this.tenantHooks.get(k)) problems.push(`tenant purge hook "${k}" is declared in the registry but not registered (LifecycleTenantHookRegistry)`);
    // Шаг стирания человека без регистрации — стирание встало бы на полпути, а данные модуля
    // пережили бы человека: старт падает
    for (const k of subjectHooks) if (!(LIFECYCLE_PENDING_KEYS[k]?.as === 'subject_hook') && !this.subjectHooks.get(k)) problems.push(`subject erasure hook "${k}" is declared in the registry but not registered (LifecycleSubjectHookRegistry)`);
    if (problems.length) {
      const msg = `lifecycle registry is invalid:\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    this.logger.log(`lifecycle registry: ${LIFECYCLE_POLICY_IDS.length} policies, ${handlers.length} purge handlers, ${hooks.length} tenant hooks, ${subjectHooks.length} subject erasure hooks`);
  }

  /**
   * Люди внутри JSON (`personIds` реестра): в живой базе есть функция, она читает каждый ключ
   * реестра, по ней стоит GIN-индекс. Иначе стирание не нашло бы имена человека в чужих
   * записях (или читало бы большую таблицу целиком) — старт падает.
   */
  private async personIdsProblems(): Promise<string[]> {
    const out: string[] = [];
    for (const id of LIFECYCLE_POLICY_IDS) {
      const spec = lifecyclePolicy(id)?.personIds;
      if (!spec) continue;
      const [fn] = await this.db.$queryRaw<Array<{ def: string | null }>>`
        SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ${spec.fn} LIMIT 1`;
      if (!fn?.def) {
        out.push(`${id}: person-ids function ${spec.fn} is missing in the database (migration not applied)`);
        continue;
      }
      for (const k of spec.keys) if (!fn.def.includes(`'${k}'`)) out.push(`${id}: person-ids function ${spec.fn} does not read the key '${k}'`);
      const [ix] = await this.db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE ${`%USING gin (${spec.fn}(%`}`;
      if (!Number(ix?.n ?? 0)) out.push(`${id}: no GIN index on ${spec.fn}(…) — erasure would scan the whole table`);
    }
    return out;
  }
}
