import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  asWorkspaceId,
  lifecyclePlatformHoldCreateSchema,
  lifecyclePlatformHoldReleaseSchema,
  lifecycleWorkspacePurgeInputSchema,
  type LifecyclePlatformHoldCreateInput,
  type LifecyclePlatformHoldReleaseInput,
  type LifecycleWorkspacePurgeInput,
} from '@superapp/shared';
import { conflict } from '../../shared/errors/api-error';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleTenantPurgeService } from './lifecycle.tenant-purge';

/**
 * Команды Кабинета платформы движка жизненного цикла.
 *
 * `lifecycle.workspace.purge` — окончательное удаление АРХИВНОЙ организации раньше срока
 * архива (запрос поддержки, юридическое требование): риск critical, всегда через второго
 * сотрудника, цель не может быть своей организацией. Живую организацию команда не тронет
 * (сначала архив — обратимо), под заморозкой — отказ. Предпросмотр — план каскада с числом
 * строк по шагам ДО удаления; исполнение ставит каскад джобом В ТРАНЗАКЦИИ команды (журнал
 * команды и джоб коммитятся вместе). Atlassian 2022: удаление скриптом с неверным видом id —
 * здесь вид проверяет БД, объём видит человек, исполнение одобряет второй.
 *
 * `lifecycle.hold.create` / `lifecycle.hold.release` — заморозка платформы (без организации:
 * держит личное человека и данные всех организаций) или от имени организации; снятие любой.
 * Обе — через второго сотрудника (`lifecycle.holds.approve`): постановка останавливает
 * обязательное стирание, снятие возобновляет удаление улик. Заморозку на самого себя
 * сотрудник не ставит (`forbidSelfTarget`).
 */
@Injectable()
export class LifecyclePlatformProvider implements OnModuleInit {
  constructor(
    private readonly commands: PlatformCommandRegistry,
    private readonly tenant: LifecycleTenantPurgeService,
    private readonly holds: LifecycleHoldsService,
  ) {}

  onModuleInit(): void {
    this.commands.register<LifecycleWorkspacePurgeInput>({
      key: 'lifecycle.workspace.purge',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleWorkspacePurge.title',
      descriptionKey: 'platform.commands.lifecycleWorkspacePurge.description',
      input: lifecycleWorkspacePurgeInputSchema,
      capability: 'lifecycle.purge.write',
      risk: 'critical',
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['workspace'],
      target: (i) => ({ type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }),
      // Предпросмотр — сколько каскад удалит по шагам плана ДО удаления (Atlassian 2022)
      preview: async (_ctx, input) => {
        const workspaceId = asWorkspaceId(input.workspaceId);
        await this.tenant.assertArchivedWorkspace(workspaceId);
        const { steps, missing } = await this.tenant.preview(workspaceId);
        return { result: { held: await this.tenant.isHeld(workspaceId, { deep: true }), missing, steps: steps.map((st) => ({ key: st.key, rows: st.rows })) } };
      },
      execute: async (_ctx, input, tx) => {
        const workspaceId = asWorkspaceId(input.workspaceId);
        if (await this.tenant.isHeld(workspaceId, { deep: true })) throw conflict('lifecycle.tenantHeld');
        const res = await this.tenant.schedule(workspaceId, tx);
        return { result: { runId: res.runId, queued: res.queued } };
      },
    });

    this.commands.register<LifecyclePlatformHoldCreateInput>({
      key: 'lifecycle.hold.create',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleHoldCreate.title',
      descriptionKey: 'platform.commands.lifecycleHoldCreate.description',
      input: lifecyclePlatformHoldCreateSchema,
      capability: 'lifecycle.holds.write',
      risk: 'high',
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['user', 'workspace'],
      target: (i) =>
        i.scope === 'custodian' && i.custodianUserId
          ? { type: 'user', id: i.custodianUserId, workspaceId: i.workspaceId ?? null }
          : i.workspaceId
            ? { type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }
            : null,
      execute: async (ctx, input, tx) => {
        const hold = await this.holds.create({ ...input, workspaceId: input.workspaceId ?? null }, { id: ctx.actor.userId, kind: 'platform' }, tx);
        return { after: hold, result: { holdId: hold.id } };
      },
    });

    this.commands.register<LifecyclePlatformHoldReleaseInput>({
      key: 'lifecycle.hold.release',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleHoldRelease.title',
      descriptionKey: 'platform.commands.lifecycleHoldRelease.description',
      input: lifecyclePlatformHoldReleaseSchema,
      capability: 'lifecycle.holds.write',
      risk: 'high',
      dualControl: true,
      target: (i) => ({ type: 'lifecycle_hold', id: i.holdId }),
      execute: async (ctx, input, tx) => {
        const hold = await this.holds.release(input.holdId, input.note, { id: ctx.actor.userId, kind: 'platform' }, {}, tx);
        return { after: hold, result: { holdId: hold.id, releasedAt: hold.releasedAt } };
      },
    });
  }
}
