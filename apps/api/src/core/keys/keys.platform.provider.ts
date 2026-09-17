import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  keysRootRotateInputSchema,
  keysSigningRotateInputSchema,
  keysWorkspaceFreezeInputSchema,
  type KeysRootRotateInput,
  type KeysSigningRotateInput,
  type KeysWorkspaceFreezeInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest } from '../../shared/errors/api-error';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { workspaceScope } from './keys.constants';
import { AUDIENCE_MAX_TTL_SEC, KeysRotationJobs } from './keys.rotation.jobs';
import { KeysSigningService } from './keys.signing.service';
import { KeysStoreService } from './keys.store.service';
import { SoftwareProvider } from './providers/software.provider';

/**
 * Команды кабинета платформы (журнал append-only, step-up, «четыре глаза» — исполнитель
 * кабинета): ротация корня (critical, dualControl, dryRun), ротация подписи аудитории,
 * заморозка/разморозка KEK организации (critical, dualControl). Панель «Ключи» карточки
 * организации и отзыв ключа регистрирует `api-keys/keys.platform.panel.ts` (фаза E).
 */
@Injectable()
export class KeysPlatformProvider implements OnModuleInit {
  constructor(
    private readonly commands: PlatformCommandRegistry,
    private readonly db: DatabaseService,
    private readonly store: KeysStoreService,
    private readonly signing: KeysSigningService,
    private readonly rotation: KeysRotationJobs,
  ) {}

  onModuleInit(): void {
    this.commands.register<KeysRootRotateInput>({
      key: 'keys.root.rotate',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysRootRotate.title',
      descriptionKey: 'platform.commands.keysRootRotate.description',
      input: keysRootRotateInputSchema,
      capability: 'keys.write',
      risk: 'critical',
      dualControl: true,
      dryRun: true,
      redact: ['newRootKeyFile'],
      target: () => ({ type: 'keys_root', id: 'root' }),
      execute: async (ctx, input, tx) => {
        // Новый корень читается с диска этого инстанса (файл создан церемонией заранее);
        // сгенерировать его молча нельзя — иначе второй копии у второго человека не будет.
        let next: SoftwareProvider;
        try {
          next = new SoftwareProvider(input.newRootKeyFile, { createIfMissing: false });
        } catch (err) {
          throw badRequest('keys.root_missing', undefined, { code: 'keys.root_missing', detail: (err as Error).message });
        }
        if (next.rootKid === this.store.provider.rootKid) throw badRequest('keys.root_missing', undefined, { code: 'keys.root_same' });
        const res = await this.store.rewrapAllToProvider(next, { actorId: ctx.actor.userId, reason: ctx.reason }, tx, false);
        return { before: { rootKid: res.fromRootKid }, after: { rootKid: res.toRootKid }, result: { versions: res.versions, restartRequired: true } };
      },
      preview: async (_ctx, input) => {
        let next: SoftwareProvider;
        try {
          next = new SoftwareProvider(input.newRootKeyFile, { createIfMissing: false });
        } catch (err) {
          throw badRequest('keys.root_missing', undefined, { code: 'keys.root_missing', detail: (err as Error).message });
        }
        const res = await this.db.$transaction((tx) => this.store.rewrapAllToProvider(next, { actorId: null, reason: null }, tx, true));
        return { before: { rootKid: res.fromRootKid }, after: { rootKid: res.toRootKid }, result: { versions: res.versions, restartRequired: true } };
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
        return { result: { versions: n } };
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
        return { result: { versions: n } };
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
