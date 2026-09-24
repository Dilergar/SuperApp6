import { Injectable, OnModuleInit } from '@nestjs/common';
import { asWorkspaceId, lifecycleWorkspacePurgeInputSchema, type LifecycleWorkspacePurgeInput } from '@superapp/shared';
import { conflict } from '../../shared/errors/api-error';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
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
 */
@Injectable()
export class LifecyclePlatformProvider implements OnModuleInit {
  constructor(
    private readonly commands: PlatformCommandRegistry,
    private readonly tenant: LifecycleTenantPurgeService,
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
        return { result: { held: await this.tenant.isHeld(workspaceId), missing, steps: steps.map((st) => ({ key: st.key, rows: st.rows })) } };
      },
      execute: async (_ctx, input, tx) => {
        const workspaceId = asWorkspaceId(input.workspaceId);
        if (await this.tenant.isHeld(workspaceId)) throw conflict('lifecycle.tenantHeld');
        const res = await this.tenant.schedule(workspaceId, tx);
        return { result: { runId: res.runId, queued: res.queued } };
      },
    });
  }
}
