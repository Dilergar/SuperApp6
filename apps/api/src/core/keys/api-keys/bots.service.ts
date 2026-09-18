import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Bot } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  KEYS_ERROR_CODES,
  normalizeKeyScopes,
  type ApiKeyCreatedDto,
  type BotCreateInput,
  type BotCreatedDto,
  type BotDetailsDto,
  type BotDto,
  type BotKeyCreateInput,
  type BotUpdateInput,
} from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { badRequest, conflict, forbidden, notFound } from '../../../shared/errors/api-error';
import { AnalyticsService } from '../../analytics/analytics.service';
import { EntitlementsService } from '../../entitlements/entitlements.service';
import { RolesService } from '../../roles/roles.service';
import { KeysAuditService, keyActorsLite } from '../keys.audit.service';
import { ApiKeyAuthService } from './api-key-auth.service';
import { botRoleOfRank, toApiKeyDto, toBotDto } from './api-keys.common';
import { ApiKeysService, type KeyActor } from './api-keys.service';
import { KeysStepUpService } from './keys-step-up.service';
import { KeysNotifier } from './keys.notifications';

type Tx = Prisma.TransactionClient;
const WS_CONTEXT = 'workspace';

/**
 * Боты организации (решение грилла №6–7): отдельный принципал с теневой строкой users
 * (`kind='bot'`) и ролью staff|manager в user_roles — бот работает в задачах, календаре,
 * документах как сотрудник с ограничением скоупами ключа. Владение — у организации;
 * уход создателя замораживает бота до решения владельца; разморозка — только owner
 * со step-up; архив — отзыв ключей и снятие ролей.
 */
@Injectable()
export class BotsService {
  private readonly logger = new Logger(BotsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: KeysAuditService,
    private readonly keys: ApiKeysService,
    private readonly auth: ApiKeyAuthService,
    private readonly notifier: KeysNotifier,
    private readonly analytics: AnalyticsService,
    private readonly stepUp: KeysStepUpService,
  ) {}

  async list(actor: KeyActor, workspaceId: string): Promise<BotDto[]> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const rows = await this.db.bot.findMany({ where: { workspaceId, archivedAt: null }, include: { keys: { select: { revokedAt: true, expiresAt: true, graceUntil: true } } }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => toBotDto(r));
  }

  async get(actor: KeyActor, workspaceId: string, botId: string): Promise<BotDetailsDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.loadBot(workspaceId, botId);
    const keys = await this.db.apiKey.findMany({ where: { botId: row.id }, orderBy: { createdAt: 'desc' } });
    const people = await keyActorsLite(this.db, [row.responsibleUserId, row.createdById].filter((v): v is string => !!v));
    return {
      ...toBotDto({ ...row, keys }),
      keys: keys.map((k) => toApiKeyDto(k, row.status)),
      responsible: row.responsibleUserId ? people[row.responsibleUserId] ?? null : null,
      createdBy: people[row.createdById] ?? null,
    };
  }

  private async loadBot(workspaceId: string, botId: string): Promise<Bot> {
    const row = await this.db.bot.findUnique({ where: { id: botId } });
    if (!row || row.workspaceId !== workspaceId) throw notFound('keys.bot.notFound');
    return row;
  }

  /** Ответственный — член команды организации (trainee+). */
  private async assertResponsible(userId: string | null | undefined, workspaceId: string): Promise<void> {
    if (!userId) return;
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (!roles.some((r) => r.role !== 'contractor')) throw badRequest('keys.responsibleNotMember');
  }

  /** Создание = бот + теневой пользователь + роль + первый ключ (show-once) — одна транзакция. */
  async create(actor: KeyActor, workspaceId: string, input: BotCreateInput): Promise<BotCreatedDto> {
    const role = await this.keys.assertManager(actor.userId, workspaceId);
    await this.stepUp.assert(actor.userId);
    await this.assertResponsible(input.responsibleUserId, workspaceId);
    const policy = await this.keys.policy(workspaceId);
    const scopes = normalizeKeyScopes(input.scopes, true);
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, documentLanguage: true } });
    if (!ws) throw notFound('workspace.notFound');
    const botUserId = randomUUID();
    const result = await this.db.$transaction(async (tx) => {
      await this.entitlements.assertCanCreate(tx, { type: 'workspace', id: workspaceId }, 'keys.maxBots');
      // Теневая строка users: без входа (пароль-заглушка), без номера (`bot:<id>`), язык — организации
      await tx.user.create({
        data: {
          id: botUserId,
          kind: 'bot',
          phone: `bot:${botUserId}`,
          password: '!',
          firstName: input.name,
          lastName: null,
          locale: ws.documentLanguage,
        },
      });
      await tx.userRole.create({ data: { userId: botUserId, role: botRoleOfRank(input.rank), context: WS_CONTEXT, tenantId: workspaceId, grantedBy: actor.userId } });
      const bot = await tx.bot.create({
        data: {
          workspaceId,
          userId: botUserId,
          name: input.name,
          glyph: input.glyph ?? null,
          rank: input.rank,
          responsibleUserId: input.responsibleUserId ?? null,
          purpose: input.purpose,
          scopes: scopes as Prisma.InputJsonValue,
          ipAllowlist: (input.ipAllowlist ?? []) as Prisma.InputJsonValue,
          createdById: actor.userId,
        },
      });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'bot', subjectId: bot.id, subjectName: bot.name, action: 'bot.created', ip: actor.ip ?? null, details: { rank: bot.rank, scopes: Object.keys(scopes), responsibleUserId: bot.responsibleUserId } });
      await this.analytics.track(tx, 'keys.bot.created', { rank: bot.rank, scopeCount: Object.keys(scopes).length, hasAllowlist: (input.ipAllowlist ?? []).length > 0 }, { userId: actor.userId, workspaceId });
      const minted = await this.keys.mintForBotTx(tx, bot, actor, { storedHint: input.storedHint, expiresInDays: input.expiresInDays, noExpiry: input.noExpiry }, role, policy);
      return { bot, key: minted.row, secret: minted.secret };
    });
    // Проекция роли бота в core/access + сброс кэшей — после коммита (как у транзакционных путей организаций)
    await this.roles.invalidateUserCache(botUserId);
    void this.notifier.changed(workspaceId);
    return { bot: toBotDto({ ...result.bot, keys: [result.key] }), key: toApiKeyDto(result.key, result.bot.status), secret: result.secret };
  }

  async update(actor: KeyActor, workspaceId: string, botId: string, input: BotUpdateInput): Promise<BotDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.loadBot(workspaceId, botId);
    if (row.status === 'archived') throw conflict('keys.bot.archived', undefined, { code: KEYS_ERROR_CODES.botArchived });
    if (input.responsibleUserId !== undefined) await this.assertResponsible(input.responsibleUserId, workspaceId);
    const scopes = input.scopes !== undefined ? normalizeKeyScopes(input.scopes, true) : null;
    const rankChanged = input.rank !== undefined && input.rank !== row.rank;
    // Ранг, скоупы и IP-список — это СИЛА уже выпущенных ключей: их правка равна выпуску нового
    // ключа и идёт под тем же сильным подтверждением (угнанная сессия не расширит бота молча)
    // (клиент может прислать прежние значения — подтверждение нужно только когда сила реально меняется)
    const stable = (v: unknown): string => JSON.stringify(Array.isArray(v) ? [...v].sort() : Object.entries((v ?? {}) as Record<string, unknown>).sort());
    const scopesChanged = !!scopes && stable(scopes) !== stable(normalizeKeyScopes(row.scopes as Record<string, unknown>, true));
    const allowlistChanged = input.ipAllowlist !== undefined && stable(input.ipAllowlist) !== stable(Array.isArray(row.ipAllowlist) ? row.ipAllowlist : []);
    if (rankChanged || scopesChanged || allowlistChanged) await this.stepUp.assert(actor.userId);
    if (input.ipAllowlist !== undefined && input.ipAllowlist.length === 0) {
      // IP-список нельзя снять, пока он — условие: политика организации либо живой бессрочный ключ
      const policy = await this.keys.policy(workspaceId);
      if (policy.requireIpAllowlist) throw badRequest('keys.policy_allowlist_required', undefined, { code: 'keys.policy_allowlist_required' });
      const noExpiry = await this.db.apiKey.count({ where: { botId: row.id, revokedAt: null, expiresAt: null } });
      if (noExpiry > 0) throw badRequest('keys.no_expiry_needs_allowlist', undefined, { code: KEYS_ERROR_CODES.noExpiryNeedsAllowlist });
    }
    const updated = await this.db.$transaction(async (tx) => {
      const u = await tx.bot.update({
        where: { id: row.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.glyph !== undefined ? { glyph: input.glyph } : {}),
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          ...(input.rank !== undefined ? { rank: input.rank } : {}),
          ...(input.responsibleUserId !== undefined ? { responsibleUserId: input.responsibleUserId } : {}),
          ...(scopes ? { scopes: scopes as Prisma.InputJsonValue } : {}),
          ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist as Prisma.InputJsonValue } : {}),
        },
      });
      if (input.name !== undefined) await tx.user.update({ where: { id: row.userId }, data: { firstName: input.name } });
      // Скоупы живут на боте и копируются в его ключи (один источник — бот)
      if (scopes) await tx.apiKey.updateMany({ where: { botId: row.id, revokedAt: null }, data: { scopes: scopes as Prisma.InputJsonValue } });
      if (rankChanged) {
        await tx.userRole.updateMany({ where: { userId: row.userId, context: WS_CONTEXT, tenantId: workspaceId }, data: { isActive: false } });
        await tx.userRole.upsert({
          where: { userId_role_context_tenantId: { userId: row.userId, role: botRoleOfRank(input.rank!), context: WS_CONTEXT, tenantId: workspaceId } },
          create: { userId: row.userId, role: botRoleOfRank(input.rank!), context: WS_CONTEXT, tenantId: workspaceId, grantedBy: actor.userId, isActive: true },
          update: { isActive: true, grantedBy: actor.userId },
        });
      }
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'bot', subjectId: row.id, subjectName: u.name, action: 'bot.updated', ip: actor.ip ?? null, details: { fields: Object.keys(input) } });
      return u;
    });
    if (rankChanged) await this.roles.invalidateUserCache(row.userId);
    if (scopes || input.ipAllowlist !== undefined) await this.invalidateKeys(row.id);
    void this.notifier.changed(workspaceId);
    return toBotDto(updated);
  }

  private async invalidateKeys(botId: string, client: Tx | DatabaseService = this.db): Promise<void> {
    const keys = await client.apiKey.findMany({ where: { botId }, select: { hash: true } });
    await Promise.all(keys.map((k) => this.auth.invalidateByHash(k.hash)));
  }

  /** Второй ключ бота (семейство новое) — например, для второй среды. */
  async createKey(actor: KeyActor, workspaceId: string, botId: string, input: BotKeyCreateInput): Promise<ApiKeyCreatedDto> {
    const role = await this.keys.assertManager(actor.userId, workspaceId);
    await this.stepUp.assert(actor.userId);
    const row = await this.loadBot(workspaceId, botId);
    if (row.status !== 'active') throw conflict(row.status === 'frozen' ? 'keys.bot.frozen' : 'keys.bot.archived', undefined, { code: row.status === 'frozen' ? KEYS_ERROR_CODES.botFrozen : KEYS_ERROR_CODES.botArchived });
    const policy = await this.keys.policy(workspaceId);
    const minted = await this.db.$transaction((tx) => this.keys.mintForBotTx(tx, row, actor, input, role, policy));
    void this.notifier.changed(workspaceId);
    return { key: toApiKeyDto(minted.row, row.status), secret: minted.secret };
  }

  /** Заморозка владельцем/админом (reason owner): ключи отвечают 403 `keys.bot.frozen`, ничего не удаляется. */
  async freeze(actor: KeyActor, workspaceId: string, botId: string): Promise<BotDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.loadBot(workspaceId, botId);
    if (row.status !== 'active') throw conflict('keys.bot.frozen', undefined, { code: KEYS_ERROR_CODES.botFrozen });
    const updated = await this.db.$transaction((tx) => this.freezeTx(tx, row, 'owner', { actorId: actor.userId, actorKind: 'user', ip: actor.ip ?? null }));
    await this.invalidateKeys(row.id);
    void this.notifier.changed(workspaceId);
    return toBotDto(updated);
  }

  async freezeTx(tx: Tx, row: Bot, reason: 'creator_left' | 'owner' | 'platform', actor: { actorId: string | null; actorKind: string; ip?: string | null }): Promise<Bot> {
    const { count } = await tx.bot.updateMany({ where: { id: row.id, status: 'active' }, data: { status: 'frozen', frozenReason: reason, frozenAt: new Date() } });
    // Сброс снимков ключей — ЗДЕСЬ, на всех путях заморозки (владелец, каскад ухода, кабинет
    // платформы): иначе ключи уволенного создателя жили бы в кэше ещё минуту
    await this.invalidateKeys(row.id, tx);
    if (count === 0) return row;
    await this.audit.log(tx, { actorId: actor.actorId, actorKind: actor.actorKind, workspaceId: row.workspaceId, subjectType: 'bot', subjectId: row.id, subjectName: row.name, action: 'bot.frozen', ip: actor.ip ?? null, details: { reason } });
    await this.notifier.botEvent(tx, 'bot.frozen', { id: row.id, name: row.name, workspaceId: row.workspaceId }, { reasonLabelKey: `keys.frozenReason.${reason}` }, { actorId: actor.actorId, ownerOnly: true });
    return { ...row, status: 'frozen', frozenReason: reason, frozenAt: new Date() };
  }

  /** Разморозка — только владелец организации, со step-up (решение грилла №7). */
  async unfreeze(actor: KeyActor, workspaceId: string, botId: string, note?: string): Promise<BotDto> {
    const role = await this.keys.assertManager(actor.userId, workspaceId);
    if (role !== 'owner') throw forbidden('keys.role_required', undefined, { code: KEYS_ERROR_CODES.roleRequired });
    await this.stepUp.assert(actor.userId);
    const row = await this.loadBot(workspaceId, botId);
    if (row.status !== 'frozen') throw conflict('keys.bot.notFrozen');
    const updated = await this.db.$transaction((tx) => this.unfreezeTx(tx, row, { actorId: actor.userId, actorKind: 'user', ip: actor.ip ?? null }, note ?? null));
    await this.invalidateKeys(row.id);
    void this.notifier.changed(workspaceId);
    return toBotDto(updated);
  }

  async unfreezeTx(tx: Tx, row: Bot, actor: { actorId: string | null; actorKind: string; ip?: string | null }, note: string | null): Promise<Bot> {
    const { count } = await tx.bot.updateMany({ where: { id: row.id, status: 'frozen' }, data: { status: 'active', frozenReason: null, frozenAt: null } });
    await this.invalidateKeys(row.id, tx);
    if (count === 0) return row;
    await this.audit.log(tx, { actorId: actor.actorId, actorKind: actor.actorKind, workspaceId: row.workspaceId, subjectType: 'bot', subjectId: row.id, subjectName: row.name, action: 'bot.unfrozen', reason: note, ip: actor.ip ?? null });
    await this.notifier.botEvent(tx, 'bot.unfrozen', { id: row.id, name: row.name, workspaceId: row.workspaceId }, {}, { actorId: actor.actorId });
    return { ...row, status: 'active', frozenReason: null, frozenAt: null };
  }

  /** Архив («удалить»): отзыв ключей, снятие ролей, теневой пользователь помечается удалённым. Хроника остаётся. */
  async archive(actor: KeyActor, workspaceId: string, botId: string): Promise<void> {
    await this.keys.assertManager(actor.userId, workspaceId);
    await this.stepUp.assert(actor.userId);
    const row = await this.loadBot(workspaceId, botId);
    if (row.status === 'archived') return;
    await this.db.$transaction((tx) => this.archiveTx(tx, row, { actorId: actor.userId, actorKind: 'user', ip: actor.ip ?? null }));
    await this.roles.invalidateUserCache(row.userId);
    await this.invalidateKeys(row.id);
    void this.notifier.changed(workspaceId);
  }

  async archiveTx(tx: Tx, row: Bot, actor: { actorId: string | null; actorKind: string; ip?: string | null }): Promise<void> {
    const { count } = await tx.bot.updateMany({ where: { id: row.id, status: { not: 'archived' } }, data: { status: 'archived', archivedAt: new Date() } });
    await this.invalidateKeys(row.id, tx);
    if (count === 0) return;
    const keys = await tx.apiKey.findMany({ where: { botId: row.id, revokedAt: null } });
    for (const k of keys) await this.keys.revokeTx(tx, k, actor, 'bot_archived', null);
    await tx.userRole.updateMany({ where: { userId: row.userId, context: WS_CONTEXT, tenantId: row.workspaceId }, data: { isActive: false } });
    await tx.user.update({ where: { id: row.userId }, data: { deletedAt: new Date() } });
    await this.audit.log(tx, { actorId: actor.actorId, actorKind: actor.actorKind, workspaceId: row.workspaceId, subjectType: 'bot', subjectId: row.id, subjectName: row.name, action: 'bot.archived', ip: actor.ip ?? null, details: { keysRevoked: keys.length } });
  }

  /** Ботов, ждущих решения владельца (значок в шапке). */
  async pending(workspaceId: string): Promise<number> {
    return this.db.bot.count({ where: { workspaceId, status: 'frozen' } });
  }
}
