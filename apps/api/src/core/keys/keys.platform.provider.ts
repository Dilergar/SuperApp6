import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  KEYS_ERROR_CODES,
  keysBlindIndexRotateInputSchema,
  keysRootRotateInputSchema,
  keysSigningCompromiseInputSchema,
  keysSigningRotateInputSchema,
  keysWorkspaceFreezeInputSchema,
  type KeysBlindIndexRotateInput,
  type KeysRootRotateInput,
  type KeysSigningCompromiseInput,
  type KeysSigningRotateInput,
  type KeysWorkspaceFreezeInput,
} from '@superapp/shared';
import { badRequest } from '../../shared/errors/api-error';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { JobsService } from '../jobs/jobs.service';
import { KeysAuditService } from './keys.audit.service';
import { KEYS_JOBS, KEY_AUDIT_ACTIONS, workspaceScope } from './keys.constants';
import { AUDIENCE_MAX_TTL_SEC, KeysRotationJobs } from './keys.rotation.jobs';
import { KeysSigningService } from './keys.signing.service';
import { KeysStoreService } from './keys.store.service';

/**
 * Команды кабинета платформы (журнал append-only, step-up, «четыре глаза» — исполнитель
 * кабинета): ротация корня (critical, dualControl, dryRun; фоновая перешивка порциями на окне
 * двух корней), смена ключа слепых индексов (critical, dualControl), ротация подписи аудитории,
 * компрометация версии подписи (critical, dualControl — метка навсегда для архивной проверки),
 * заморозка/разморозка KEK организации (critical, dualControl). Панель «Ключи» карточки
 * организации и отзыв ключа регистрирует `api-keys/keys.platform.panel.ts` (фаза E).
 */
@Injectable()
export class KeysPlatformProvider implements OnModuleInit {
  constructor(
    private readonly commands: PlatformCommandRegistry,
    private readonly store: KeysStoreService,
    private readonly signing: KeysSigningService,
    private readonly rotation: KeysRotationJobs,
    private readonly jobs: JobsService,
    private readonly audit: KeysAuditService,
  ) {}

  /** Следующий корень загружен на ЭТОМ инстансе, его отпечаток — тот, что назвал сотрудник, и чужих корней в keystore нет. */
  private async assertRootRotationReady(newRootKid: string) {
    const st = await this.store.rootRotationStatus();
    if (newRootKid === st.rootKid) throw badRequest('keys.root_same', undefined, { code: 'keys.root_same' });
    if (st.nextRootKid !== newRootKid) throw badRequest('keys.root_next_not_loaded', undefined, { code: KEYS_ERROR_CODES.rootNextNotLoaded });
    return st;
  }

  onModuleInit(): void {
    this.commands.register<KeysRootRotateInput>({
      key: 'keys.root.rotate',
      version: 2,
      group: 'keys',
      titleKey: 'platform.commands.keysRootRotate.title',
      descriptionKey: 'platform.commands.keysRootRotate.description',
      input: keysRootRotateInputSchema,
      capability: 'keys.write',
      risk: 'critical',
      dualControl: true,
      dryRun: true,
      target: () => ({ type: 'keys_root', id: 'root' }),
      execute: async (ctx, input, tx) => {
        // Новый корень заранее выложен церемонией на КАЖДЫЙ инстанс (`KEYS_ROOT_KEY_FILE_NEXT`):
        // команда сверяет отпечаток и перекличку и ставит фоновую перешивку порциями. Одной
        // транзакцией весь keystore не перешить: у каждого человека и организации свой KEK.
        const st = await this.assertRootRotationReady(input.newRootKid);
        await this.rotation.assertFleetHoldsRoot(input.newRootKid);
        await this.jobs.enqueue(tx, { type: KEYS_JOBS.rootRewrap, payload: {}, uniqueKey: `root:${input.newRootKid}` });
        await this.audit.log(tx, { actorId: ctx.actor.userId, actorKind: 'platform', subjectType: 'root', subjectId: input.newRootKid, subjectName: `root ${st.rootKid} → ${input.newRootKid}`, action: KEY_AUDIT_ACTIONS.rootRotationStarted, reason: ctx.reason, details: { versions: st.underCurrent } });
        return { before: { rootKid: st.rootKid }, after: { rootKid: input.newRootKid }, result: { versions: st.underCurrent, alreadyUnderNext: st.underNext, background: true, restartRequired: true } };
      },
      preview: async (_ctx, input) => {
        const st = await this.assertRootRotationReady(input.newRootKid);
        return { before: { rootKid: st.rootKid }, after: { rootKid: input.newRootKid }, result: { versions: st.underCurrent, alreadyUnderNext: st.underNext, background: true, restartRequired: true } };
      },
    });

    this.commands.register<KeysBlindIndexRotateInput>({
      key: 'keys.blindindex.rotate',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysBlindIndexRotate.title',
      descriptionKey: 'platform.commands.keysBlindIndexRotate.description',
      input: keysBlindIndexRotateInputSchema,
      capability: 'keys.write',
      risk: 'critical',
      dualControl: true,
      target: () => ({ type: 'mac_key', id: 'blind_index' }),
      execute: async (ctx) => {
        const { kid } = await this.rotation.rotateBlindIndex({ actorId: ctx.actor.userId, reason: ctx.reason });
        return { result: { kid, background: true } };
      },
    });

    this.commands.register<KeysSigningRotateInput>({
      key: 'keys.signing.rotate',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysSigningRotate.title',
      descriptionKey: 'platform.commands.keysSigningRotate.description',
      input: keysSigningRotateInputSchema,
      capability: 'keys.write',
      risk: 'high',
      target: (i) => ({ type: 'signing_key', id: i.audience }),
      execute: async (ctx, input) => {
        const { kid } = await this.signing.rotate(input.audience, { actorId: ctx.actor.userId, reason: ctx.reason, retireAfterSec: AUDIENCE_MAX_TTL_SEC[input.audience] });
        return { result: { kid, audience: input.audience } };
      },
    });

    this.commands.register<KeysSigningCompromiseInput>({
      key: 'keys.signing.compromise',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysSigningCompromise.title',
      descriptionKey: 'platform.commands.keysSigningCompromise.description',
      input: keysSigningCompromiseInputSchema,
      capability: 'keys.write',
      risk: 'critical',
      dualControl: true,
      target: (i) => ({ type: 'signing_key', id: i.audience }),
      execute: async (ctx, input) => {
        // Метка навсегда: архивная проверка отвергает версию в любом состоянии. Primary сначала
        // заменяется новой версией (одна транзакция keystore). Перезаверение артефактов — их владелец.
        const res = await this.signing.compromise(input.audience, input.kid, { actorId: ctx.actor.userId, actorKind: 'platform', reason: ctx.reason });
        if (!res.compromised) throw badRequest('keys.version_not_found', undefined, { code: 'keys.version_not_found' });
        return { result: { audience: input.audience, kid: input.kid, newPrimaryKid: res.newPrimaryKid } };
      },
    });

    this.commands.register<KeysWorkspaceFreezeInput>({
      key: 'keys.workspace.freeze',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysWorkspaceFreeze.title',
      descriptionKey: 'platform.commands.keysWorkspaceFreeze.description',
      input: keysWorkspaceFreezeInputSchema,
      capability: 'keys.write',
      risk: 'critical',
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['workspace'],
      target: (i) => ({ type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }),
      execute: async (ctx, input, tx) => {
        const n = await this.store.freezeScope(workspaceScope(input.workspaceId), { actorId: ctx.actor.userId, actorKind: 'platform', reason: ctx.reason }, tx);
        // Kill-switch обязан сработать за секунду: эпоха сбрасывается ПОСЛЕ коммита команды
        return { result: { versions: n }, afterCommit: () => this.store.bumpEpoch() };
      },
    });

    this.commands.register<KeysWorkspaceFreezeInput>({
      key: 'keys.workspace.unfreeze',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysWorkspaceUnfreeze.title',
      descriptionKey: 'platform.commands.keysWorkspaceUnfreeze.description',
      input: keysWorkspaceFreezeInputSchema,
      capability: 'keys.write',
      risk: 'critical',
      dualControl: true,
      entities: ['workspace'],
      target: (i) => ({ type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }),
      execute: async (ctx, input, tx) => {
        const n = await this.store.unfreezeScope(workspaceScope(input.workspaceId), { actorId: ctx.actor.userId, actorKind: 'platform', reason: ctx.reason }, tx);
        return { result: { versions: n }, afterCommit: () => this.store.bumpEpoch() };
      },
    });

    this.commands.register<KeysWorkspaceFreezeInput>({
      key: 'keys.workspace.rotateKek',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysWorkspaceRotateKek.title',
      descriptionKey: 'platform.commands.keysWorkspaceRotateKek.description',
      input: keysWorkspaceFreezeInputSchema,
      capability: 'keys.write',
      risk: 'high',
      entities: ['workspace'],
      target: (i) => ({ type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }),
      execute: async (ctx, input) => {
        const kid = await this.rotation.rotateKek(workspaceScope(input.workspaceId), { actorId: ctx.actor.userId, reason: ctx.reason });
        return { result: { kid } };
      },
    });
  }
}
