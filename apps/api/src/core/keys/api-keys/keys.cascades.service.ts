import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../../shared/database/database.service';
import { RolesService } from '../../roles/roles.service';
import { userScope, workspaceScope } from '../keys.constants';
import { KeysStoreService } from '../keys.store.service';
import { ApiKeysService } from './api-keys.service';
import { BotsService } from './bots.service';
import { KeysNotifier } from './keys.notifications';

type Tx = Prisma.TransactionClient;

/**
 * Каскады ухода (правило «на всех путях», решение грилла №7). Один хелпер на каждый путь:
 *  - `onMemberLeft` — исключение, выход, увольнение по ТК, понижение с admin: личные ключи
 *    человека в этой организации гаснут сразу; его боты → `frozen` (creator_left) до решения
 *    владельца; именной ответственный снимается с уведомлением.
 *  - `onTokenEpochBump` — смена пароля / logout-all: все личные ключи человека отозваны.
 *  - `onWorkspacePurge` — архив/purge организации: ключи отозваны, боты в архив, KEK
 *    организации на уничтожение (crypto-shredding, 30 дней).
 *  - `onAccountAnonymize` — удаление аккаунта: личные ключи, боты создателя, KEK человека.
 * Всё — В транзакции вызывающего; уведомления и сокеты — после коммита (`after`).
 */
@Injectable()
export class KeysCascadesService {
  private readonly logger = new Logger(KeysCascadesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly keys: ApiKeysService,
    private readonly bots: BotsService,
    private readonly store: KeysStoreService,
    private readonly roles: RolesService,
    private readonly notifier: KeysNotifier,
  ) {}

  /** Вызов вне транзакции (`tx = null`) открывает свою: каскад атомарен сам по себе. */
  private async inTx<T>(tx: Tx | null, run: (t: Tx) => Promise<T>): Promise<T> {
    return tx ? run(tx) : this.db.$transaction(run);
  }

  async onMemberLeft(tx: Tx | null, workspaceId: string, userId: string, reason: 'removed' | 'left' | 'dismissed' | 'demoted' | 'purged', actorId: string | null): Promise<() => Promise<void>> {
    const after = await this.inTx(tx, (t) => this.memberLeftTx(t, workspaceId, userId, reason, actorId));
    if (!tx) await after();
    return after;
  }

  private async memberLeftTx(tx: Tx, workspaceId: string, userId: string, reason: string, actorId: string | null): Promise<() => Promise<void>> {
    const actor = { actorId, actorKind: actorId ? 'user' : 'system' };
    const pats = await tx.apiKey.findMany({ where: { kind: 'pat', userId, workspaceId, revokedAt: null } });
    for (const k of pats) await this.keys.revokeTx(tx, k, actor, 'member_left', reason);
    const created = await tx.bot.findMany({ where: { workspaceId, createdById: userId, status: 'active' } });
    for (const b of created) await this.bots.freezeTx(tx, b, 'creator_left', actor);
    const responsible = await tx.bot.findMany({ where: { workspaceId, responsibleUserId: userId, status: { not: 'archived' } } });
    if (responsible.length) {
      await tx.bot.updateMany({ where: { id: { in: responsible.map((b) => b.id) } }, data: { responsibleUserId: null } });
      const person = await tx.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
      const personName = [person?.firstName, person?.lastName].filter(Boolean).join(' ');
      for (const b of responsible) {
        await this.notifier.botEvent(tx, 'bot.responsible.left', { id: b.id, name: b.name, workspaceId }, { personName }, { actorId });
      }
    }
    const touched = pats.length + created.length + responsible.length;
    return async () => {
      if (touched) void this.notifier.changed(workspaceId);
    };
  }

  /** Поколение токенов вперёд (смена пароля, logout-all) — личные ключи человека гаснут везде. */
  async onTokenEpochBump(tx: Tx, userId: string): Promise<void> {
    const pats = await tx.apiKey.findMany({ where: { kind: 'pat', userId, revokedAt: null } });
    for (const k of pats) await this.keys.revokeTx(tx, k, { actorId: userId, actorKind: 'user' }, 'token_epoch', null);
  }

  /**
   * Отзыв личных ключей человека БЕЗ бампа поколения токенов (мастер «Это не я», core/audit):
   * бамп погасил бы и текущую сессию — ту самую, из которой человек защищает аккаунт.
   * Возвращает число отозванных ключей.
   */
  async revokePersonalKeys(tx: Tx, userId: string, reason: 'not_me'): Promise<number> {
    const pats = await tx.apiKey.findMany({ where: { kind: 'pat', userId, revokedAt: null } });
    for (const k of pats) await this.keys.revokeTx(tx, k, { actorId: userId, actorKind: 'user' }, reason, null);
    return pats.length;
  }

  /** Понижение с admin: ключи организации у человека без права их иметь гаснут; боты — на решение владельца. */
  async onRoleChanged(tx: Tx | null, workspaceId: string, userId: string, fromRole: string, toRole: string, actorId: string): Promise<() => Promise<void>> {
    const wasManager = fromRole === 'owner' || fromRole === 'admin';
    const isManager = toRole === 'owner' || toRole === 'admin';
    if (wasManager && !isManager) return this.onMemberLeft(tx, workspaceId, userId, 'demoted', actorId);
    return async () => undefined;
  }

  async onWorkspacePurge(tx: Tx, workspaceId: string): Promise<void> {
    const actor = { actorId: null, actorKind: 'system' } as const;
    const keys = await tx.apiKey.findMany({ where: { OR: [{ workspaceId }, { bot: { workspaceId } }], revokedAt: null } });
    for (const k of keys) await this.keys.revokeTx(tx, k, actor, 'policy', 'workspace purged');
    const bots = await tx.bot.findMany({ where: { workspaceId, status: { not: 'archived' } } });
    for (const b of bots) await this.bots.archiveTx(tx, b, actor);
    await this.store.scheduleScopeDestroy(workspaceScope(workspaceId), { actorKind: 'system', reason: 'workspace purged' }, tx);
    for (const b of bots) await this.roles.invalidateUserCache(b.userId).catch(() => undefined);
  }

  async onAccountAnonymize(tx: Tx, userId: string): Promise<void> {
    const actor = { actorId: null, actorKind: 'system' } as const;
    const pats = await tx.apiKey.findMany({ where: { kind: 'pat', userId, revokedAt: null } });
    for (const k of pats) await this.keys.revokeTx(tx, k, actor, 'token_epoch', 'account deleted');
    const created = await tx.bot.findMany({ where: { createdById: userId, status: 'active' } });
    for (const b of created) await this.bots.freezeTx(tx, b, 'creator_left', actor);
    await tx.bot.updateMany({ where: { responsibleUserId: userId }, data: { responsibleUserId: null } });
    await this.store.scheduleScopeDestroy(userScope(userId), { actorKind: 'system', reason: 'account anonymized' }, tx);
  }

  /**
   * После коммита `onWorkspacePurge` / `onAccountAnonymize`: сброс эпохи keystore, чтобы KEK
   * субъекта перестал работать на всех инстансах сразу (внутри транзакции сброс бесполезен —
   * параллельное чтение вернуло бы в кэш ещё живую версию). Забытый вызов страхуют
   * отложенные сбросы самого keystore.
   */
  async afterScopeDestroyCommitted(): Promise<void> {
    await this.store.bumpEpoch();
  }

  /** Плановое удаление аккаунта (грейс 30 дней): личные ключи гаснут сразу — восстановление их не вернёт. */
  async onDeletionScheduled(userId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const pats = await tx.apiKey.findMany({ where: { kind: 'pat', userId, revokedAt: null } });
      for (const k of pats) await this.keys.revokeTx(tx, k, { actorId: userId, actorKind: 'user' }, 'token_epoch', 'deletion scheduled');
    });
  }
}
