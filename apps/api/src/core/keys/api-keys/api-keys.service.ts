import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ApiKey, type Bot, type WorkspaceKeyPolicy } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  KEYS_ERROR_CODES,
  KEYS_LIMITS,
  normalizeKeyScopes,
  type ApiKeyCreateInput,
  type ApiKeyCreatedDto,
  type ApiKeyDto,
  type ApiKeyRevokeReason,
  type ApiKeyRotateInput,
  type ApiKeyUpdateInput,
  type ApiKeyVerifyDto,
  type BotKeyCreateInput,
  type KeysLeakedInput,
  type WorkspaceKeyPolicyDto,
} from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { badRequest, conflict, forbidden, notFound } from '../../../shared/errors/api-error';
import { AnalyticsService } from '../../analytics/analytics.service';
import { EntitlementsService } from '../../entitlements/entitlements.service';
import { RolesService } from '../../roles/roles.service';
import { KeysAuditService } from '../keys.audit.service';
import { KeysMacService } from '../keys.mac.service';
import { ApiKeyAuthService } from './api-key-auth.service';
import { apiKeyEnv, keyIsLive, keyStatusOf, toApiKeyDto } from './api-keys.common';
import { generateApiSecret, hashApiSecret, parseApiSecret } from './api-keys.format';
import { KeysStepUpService } from './keys-step-up.service';
import { KeysNotifier } from './keys.notifications';

type Tx = Prisma.TransactionClient;

export interface KeyActor {
  userId: string;
  ip?: string | null;
}

const WS_CONTEXT = 'workspace';

/**
 * Ключи API: чеканка (show-once), ротация с перекрытием, отзыв, политика сроков,
 * личные ключи (данные организации — только owner/admin; собственные данные — любому),
 * сигнал утечки, validity-check. Секрет живёт в ответе создания и нигде больше.
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: KeysAuditService,
    private readonly mac: KeysMacService,
    private readonly auth: ApiKeyAuthService,
    private readonly notifier: KeysNotifier,
    private readonly analytics: AnalyticsService,
    private readonly stepUp: KeysStepUpService,
  ) {}

  // ------------------------------------------------------------
  // Гейты и политика
  // ------------------------------------------------------------

  /** Ключи организации создают и видят только владелец и админы (решение грилла №11). */
  async assertManager(userId: string, workspaceId: string): Promise<'owner' | 'admin'> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    const names = roles.map((r) => r.role);
    if (names.includes('owner')) return 'owner';
    if (names.includes('admin')) return 'admin';
    throw forbidden('keys.role_required', undefined, { code: KEYS_ERROR_CODES.roleRequired });
  }

  async policy(workspaceId: string): Promise<WorkspaceKeyPolicy> {
    const row = await this.db.workspaceKeyPolicy.findUnique({ where: { workspaceId } });
    return row ?? { workspaceId, maxPatDays: KEYS_LIMITS.patDefaultDays, maxBotKeyDays: KEYS_LIMITS.botKeyDefaultDays, requireIpAllowlist: false, updatedAt: new Date() };
  }

  toPolicyDto(p: WorkspaceKeyPolicy): WorkspaceKeyPolicyDto {
    return { workspaceId: p.workspaceId, maxPatDays: p.maxPatDays, maxBotKeyDays: p.maxBotKeyDays, requireIpAllowlist: p.requireIpAllowlist };
  }

  /**
   * Срок ключа по политике: PAT — дефолт 90, потолок 365 (или уже политики); ключ бота —
   * дефолт год, «бессрочно» — только владелец, только с IP-списком и только если политика
   * не задаёт потолка. Ошибки — машинные коды, текст подбирает каталог.
   */
  resolveExpiry(opts: {
    kind: 'bot' | 'pat';
    role: 'owner' | 'admin' | null;
    policy: WorkspaceKeyPolicy | null;
    input: { expiresInDays?: number; noExpiry?: boolean };
    hasAllowlist: boolean;
  }): Date | null {
    const { kind, role, policy, input, hasAllowlist } = opts;
    if (policy?.requireIpAllowlist && !hasAllowlist) {
      throw badRequest('keys.policy_allowlist_required', undefined, { code: 'keys.policy_allowlist_required' });
    }
    if (kind === 'bot') {
      const max = policy ? policy.maxBotKeyDays : KEYS_LIMITS.botKeyDefaultDays;
      if (input.noExpiry) {
        if (role !== 'owner') throw forbidden('keys.no_expiry_owner_only', undefined, { code: 'keys.no_expiry_owner_only' });
        if (!hasAllowlist) throw badRequest('keys.no_expiry_needs_allowlist', undefined, { code: KEYS_ERROR_CODES.noExpiryNeedsAllowlist });
        if (max !== null) throw badRequest('keys.policy_max_days', { days: max }, { code: KEYS_ERROR_CODES.policyMaxDays });
        return null;
      }
      const days = input.expiresInDays ?? Math.min(KEYS_LIMITS.botKeyDefaultDays, max ?? KEYS_LIMITS.botKeyDefaultDays);
      if (max !== null && days > max) throw badRequest('keys.policy_max_days', { days: max }, { code: KEYS_ERROR_CODES.policyMaxDays });
      return new Date(Date.now() + days * 86_400_000);
    }
    const max = Math.min(policy?.maxPatDays ?? KEYS_LIMITS.patMaxDays, KEYS_LIMITS.patMaxDays);
    if (input.noExpiry) throw badRequest('keys.policy_max_days', { days: max }, { code: KEYS_ERROR_CODES.policyMaxDays });
    const days = input.expiresInDays ?? Math.min(KEYS_LIMITS.patDefaultDays, max);
    if (days > max) throw badRequest('keys.policy_max_days', { days: max }, { code: KEYS_ERROR_CODES.policyMaxDays });
    return new Date(Date.now() + days * 86_400_000);
  }

  // ------------------------------------------------------------
  // Чеканка
  // ------------------------------------------------------------

  private async mint(kind: 'bot' | 'pat'): Promise<{ secret: string; prefix: string; last4: string; hash: string; hashKid: string }> {
    const gen = generateApiSecret(kind, apiKeyEnv());
    const pepper = await this.mac.pepper();
    return { ...gen, hash: hashApiSecret(pepper.material, gen.secret), hashKid: pepper.kid };
  }

  /** Ключ бота в транзакции создания бота / выпуска второго ключа. Права проверил вызывающий. */
  async mintForBotTx(
    tx: Tx,
    bot: Bot,
    actor: KeyActor,
    input: BotKeyCreateInput,
    role: 'owner' | 'admin',
    policy: WorkspaceKeyPolicy,
    opts: { familyId?: string; rotatedFromId?: string | null } = {},
  ): Promise<{ row: ApiKey; secret: string }> {
    const allowlist = Array.isArray(bot.ipAllowlist) ? (bot.ipAllowlist as string[]) : [];
    const expiresAt = this.resolveExpiry({ kind: 'bot', role, policy, input, hasAllowlist: allowlist.length > 0 });
    const minted = await this.mint('bot');
    const familyId = opts.familyId ?? randomUUID();
    await this.assertFamilyRoom(tx, familyId);
    const row = await tx.apiKey.create({
      data: {
        kind: 'bot',
        botId: bot.id,
        userId: null,
        workspaceId: bot.workspaceId,
        familyId,
        name: input.name ?? bot.name,
        purpose: input.purpose ?? bot.purpose,
        prefix: minted.prefix,
        last4: minted.last4,
        hash: minted.hash,
        hashKid: minted.hashKid,
        scopes: bot.scopes as Prisma.InputJsonValue,
        ipAllowlist: [] as Prisma.InputJsonValue,
        expiresAt,
        rotatedFromId: opts.rotatedFromId ?? null,
        storedHint: input.storedHint ?? null,
        createdById: actor.userId,
      },
    });
    await this.audit.log(tx, {
      actorId: actor.userId,
      workspaceId: bot.workspaceId,
      subjectType: 'api_key',
      subjectId: row.id,
      subjectName: row.name,
      action: opts.rotatedFromId ? 'api_key.rotated' : 'api_key.created',
      ip: actor.ip ?? null,
      details: { kind: 'bot', botId: bot.id, prefix: row.prefix, expiresAt: expiresAt?.toISOString() ?? null, rotatedFromId: opts.rotatedFromId ?? null },
    });
    await this.analytics.track(tx, 'keys.key.created', { kind: 'bot', contextType: 'workspace', hasExpiry: !!expiresAt, hasAllowlist: allowlist.length > 0, rotation: !!opts.rotatedFromId }, { userId: actor.userId, workspaceId: bot.workspaceId });
    await this.notifier.keyEvent(tx, 'key.created', { id: row.id, name: row.name, userId: null, workspaceId: bot.workspaceId }, { purpose: row.purpose }, { actorId: actor.userId });
    return { row, secret: minted.secret };
  }

  /** ≤ 2 живых ключей в семействе (ротация с перекрытием). */
  private async assertFamilyRoom(tx: Tx, familyId: string): Promise<void> {
    // «Посчитал — вставил» без замка пропускало две одновременные ротации: живых стало бы три
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`keys:family:${familyId}`}))`;
    const live = await tx.apiKey.findMany({ where: { familyId, revokedAt: null }, select: { revokedAt: true, expiresAt: true, graceUntil: true } });
    if (live.filter((k) => keyIsLive(k)).length >= KEYS_LIMITS.familyMaxLive) {
      throw conflict('keys.family_full', undefined, { code: KEYS_ERROR_CODES.familyFull });
    }
  }

  // ------------------------------------------------------------
  // Личные ключи (PAT): данные организации — owner/admin; собственные данные — любому
  // ------------------------------------------------------------

  async createPersonal(actor: KeyActor, workspaceId: string | null, input: ApiKeyCreateInput): Promise<ApiKeyCreatedDto> {
    let role: 'owner' | 'admin' | null = null;
    let policy: WorkspaceKeyPolicy | null = null;
    if (workspaceId) {
      role = await this.assertManager(actor.userId, workspaceId);
      policy = await this.policy(workspaceId);
    }
    await this.stepUp.assert(actor.userId);
    const scopes = normalizeKeyScopes(input.scopes, false);
    const allowlist = input.ipAllowlist ?? [];
    const expiresAt = this.resolveExpiry({ kind: 'pat', role, policy, input, hasAllowlist: allowlist.length > 0 });
    const minted = await this.mint('pat');
    const created = await this.db.$transaction(async (tx) => {
      await this.entitlements.assertCanCreate(tx, { type: 'user', id: actor.userId }, 'keys.maxPersonalTokens');
      const row = await tx.apiKey.create({
        data: {
          kind: 'pat',
          botId: null,
          userId: actor.userId,
          workspaceId,
          familyId: randomUUID(),
          name: input.name,
          purpose: input.purpose,
          prefix: minted.prefix,
          last4: minted.last4,
          hash: minted.hash,
          hashKid: minted.hashKid,
          scopes: scopes as Prisma.InputJsonValue,
          ipAllowlist: allowlist as Prisma.InputJsonValue,
          expiresAt,
          storedHint: input.storedHint ?? null,
          createdById: actor.userId,
        },
      });
      await this.audit.log(tx, {
        actorId: actor.userId,
        workspaceId,
        subjectType: 'api_key',
        subjectId: row.id,
        subjectName: row.name,
        action: 'api_key.created',
        ip: actor.ip ?? null,
        details: { kind: 'pat', prefix: row.prefix, expiresAt: expiresAt?.toISOString() ?? null, scopes: Object.keys(scopes).length },
      });
      await this.analytics.track(tx, 'keys.key.created', { kind: 'pat', contextType: workspaceId ? 'workspace' : 'personal', hasExpiry: !!expiresAt, hasAllowlist: allowlist.length > 0, rotation: false }, { userId: actor.userId, workspaceId });
      await this.notifier.keyEvent(tx, 'key.created', { id: row.id, name: row.name, userId: actor.userId, workspaceId }, { purpose: row.purpose }, { actorId: actor.userId });
      return row;
    });
    if (workspaceId) void this.notifier.changed(workspaceId);
    return { key: toApiKeyDto(created, null), secret: minted.secret };
  }

  async listPersonal(userId: string, workspaceId: string | null): Promise<ApiKeyDto[]> {
    const rows = await this.db.apiKey.findMany({ where: { kind: 'pat', userId, workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => toApiKeyDto(r, null));
  }

  /** Личные ключи ВСЕХ людей для данных организации (реестр; owner/admin). */
  async listWorkspacePersonal(workspaceId: string): Promise<ApiKeyDto[]> {
    const rows = await this.db.apiKey.findMany({ where: { kind: 'pat', workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => toApiKeyDto(r, null));
  }

  // ------------------------------------------------------------
  // Доступ к строке ключа: владелец PAT либо owner/admin организации ключа
  // ------------------------------------------------------------

  private async loadForManage(actor: KeyActor, keyId: string, workspaceId: string | null): Promise<{ row: ApiKey & { bot: Bot | null }; role: 'owner' | 'admin' | null }> {
    const row = await this.db.apiKey.findUnique({ where: { id: keyId }, include: { bot: true } });
    if (!row) throw notFound('keys.keyNotFound');
    const ws = row.bot?.workspaceId ?? row.workspaceId;
    if (workspaceId !== null && ws !== workspaceId) throw notFound('keys.keyNotFound');
    if (ws) {
      const role = await this.assertManager(actor.userId, ws);
      return { row, role };
    }
    if (row.userId !== actor.userId) throw notFound('keys.keyNotFound');
    return { row, role: null };
  }

  /**
   * Личный ключ действует ОТ ИМЕНИ своего держателя. Владелец и админы организации видят
   * его в реестре и могут ОТОЗВАТЬ, но не перевыпустить и не править: перевыпуск отдаёт
   * новый секрет вызывающему — админ получил бы ключ с правами владельца (и его именем в
   * хронике), а правка IP-списка сняла бы с чужого ключа сетевое ограничение.
   */
  private assertHolder(actor: KeyActor, row: ApiKey): void {
    if (row.kind === 'pat' && row.userId !== actor.userId) {
      throw forbidden('keys.holder_only', undefined, { code: KEYS_ERROR_CODES.holderOnly });
    }
  }

  async update(actor: KeyActor, keyId: string, workspaceId: string | null, input: ApiKeyUpdateInput): Promise<ApiKeyDto> {
    const { row } = await this.loadForManage(actor, keyId, workspaceId);
    this.assertHolder(actor, row);
    // Политика «IP-список обязателен» действует и на правку: иначе создал со списком — и снял его
    if (input.ipAllowlist !== undefined && input.ipAllowlist.length === 0 && row.kind === 'pat' && row.workspaceId) {
      const policy = await this.policy(row.workspaceId);
      if (policy.requireIpAllowlist) throw badRequest('keys.policy_allowlist_required', undefined, { code: 'keys.policy_allowlist_required' });
    }
    // Сетевое ограничение ключа — часть его силы: менять его можно только под step-up
    if (input.ipAllowlist !== undefined) await this.stepUp.assert(actor.userId);
    const updated = await this.db.$transaction(async (tx) => {
      const u = await tx.apiKey.update({
        where: { id: row.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.storedHint !== undefined ? { storedHint: input.storedHint } : {}),
          ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist as Prisma.InputJsonValue } : {}),
        },
      });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId: row.bot?.workspaceId ?? row.workspaceId, subjectType: 'api_key', subjectId: row.id, subjectName: u.name, action: 'api_key.updated', ip: actor.ip ?? null, details: { fields: Object.keys(input) } });
      return u;
    });
    await this.auth.invalidateByHash(row.hash);
    return toApiKeyDto(updated, row.bot?.status ?? null);
  }

  /** Ротация: новый секрет того же семейства, старый живёт до `graceUntil` (0 ч — отзыв сразу). */
  async rotate(actor: KeyActor, keyId: string, workspaceId: string | null, input: ApiKeyRotateInput): Promise<ApiKeyCreatedDto> {
    const { row, role } = await this.loadForManage(actor, keyId, workspaceId);
    this.assertHolder(actor, row);
    if (!keyIsLive(row)) throw conflict('keys.revoked', undefined, { code: KEYS_ERROR_CODES.revoked });
    await this.stepUp.assert(actor.userId);
    const ws = row.bot?.workspaceId ?? row.workspaceId;
    const policy = ws ? await this.policy(ws) : null;
    const graceUntil = input.graceHours > 0 ? new Date(Date.now() + input.graceHours * 3_600_000) : null;
    const result = await this.db.$transaction(async (tx) => {
      let minted: { row: ApiKey; secret: string };
      if (row.kind === 'bot' && row.bot) {
        // Новый секрет наследует правило срока старого: бессрочный остаётся бессрочным (владелец + IP-список), срочный — получает полный срок по политике
        minted = await this.mintForBotTx(tx, row.bot, actor, { name: row.name, purpose: row.purpose, storedHint: input.storedHint, noExpiry: row.expiresAt === null }, role ?? 'admin', policy ?? (await this.policy(row.bot.workspaceId)), { familyId: row.familyId, rotatedFromId: row.id });
      } else {
        const allowlist = Array.isArray(row.ipAllowlist) ? (row.ipAllowlist as string[]) : [];
        const expiresAt = this.resolveExpiry({ kind: 'pat', role, policy, input: {}, hasAllowlist: allowlist.length > 0 });
        const m = await this.mint('pat');
        await this.assertFamilyRoom(tx, row.familyId);
        const created = await tx.apiKey.create({
          data: {
            kind: 'pat',
            botId: null,
            userId: row.userId,
            workspaceId: row.workspaceId,
            familyId: row.familyId,
            name: row.name,
            purpose: row.purpose,
            prefix: m.prefix,
            last4: m.last4,
            hash: m.hash,
            hashKid: m.hashKid,
            scopes: row.scopes as Prisma.InputJsonValue,
            ipAllowlist: row.ipAllowlist as Prisma.InputJsonValue,
            expiresAt,
            rotatedFromId: row.id,
            storedHint: input.storedHint ?? row.storedHint,
            createdById: actor.userId,
          },
        });
        await this.audit.log(tx, { actorId: actor.userId, workspaceId: row.workspaceId, subjectType: 'api_key', subjectId: created.id, subjectName: created.name, action: 'api_key.rotated', ip: actor.ip ?? null, details: { rotatedFromId: row.id, graceUntil: graceUntil?.toISOString() ?? null } });
        await this.analytics.track(tx, 'keys.key.created', { kind: 'pat', contextType: row.workspaceId ? 'workspace' : 'personal', hasExpiry: !!expiresAt, hasAllowlist: allowlist.length > 0, rotation: true }, { userId: actor.userId, workspaceId: row.workspaceId });
        minted = { row: created, secret: m.secret };
      }
      // Старый ключ: grace-окно либо немедленный отзыв
      // Status-guarded: ключ, отозванный параллельно (утечка, каскад), не «оживает» grace-окном
      const { count } = await tx.apiKey.updateMany({
        where: { id: row.id, revokedAt: null },
        data: graceUntil ? { graceUntil } : { revokedAt: new Date(), revokedReason: 'rotated' satisfies ApiKeyRevokeReason },
      });
      if (count === 0) throw conflict('keys.revoked', undefined, { code: KEYS_ERROR_CODES.revoked });
      return minted;
    });
    await this.auth.invalidateByHash(row.hash);
    if (ws) void this.notifier.changed(ws);
    return { key: toApiKeyDto(result.row, row.bot?.status ?? null), secret: result.secret };
  }

  async revoke(actor: KeyActor, keyId: string, workspaceId: string | null, reason: ApiKeyRevokeReason, note?: string): Promise<ApiKeyDto> {
    const { row } = await this.loadForManage(actor, keyId, workspaceId);
    const updated = await this.db.$transaction((tx) => this.revokeTx(tx, row, { actorId: actor.userId, actorKind: 'user', ip: actor.ip ?? null }, reason, note ?? null));
    const ws = row.bot?.workspaceId ?? row.workspaceId;
    if (ws) void this.notifier.changed(ws);
    return toApiKeyDto(updated, row.bot?.status ?? null);
  }

  /** Отзыв в транзакции (каскады, кабинет, утечка): идемпотентен — уже отозванный не трогается. */
  async revokeTx(tx: Tx, row: ApiKey, actor: { actorId: string | null; actorKind: string; ip?: string | null }, reason: ApiKeyRevokeReason, note: string | null): Promise<ApiKey> {
    if (row.revokedAt) return row;
    // Status-guarded: два отзыва разом (каскад + сканер утечек) не переписывают причину друг друга
    // и не шлют два уведомления; сброс кэша идёт в любом случае — он идемпотентен
    const { count } = await tx.apiKey.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason, revokedNote: note } });
    await this.auth.invalidateByHash(row.hash);
    const updated = await tx.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    if (count === 0) return updated;
    const workspaceId = row.workspaceId ?? (row.botId ? (await tx.bot.findUnique({ where: { id: row.botId }, select: { workspaceId: true } }))?.workspaceId ?? null : null);
    await this.audit.log(tx, { actorId: actor.actorId, actorKind: actor.actorKind, workspaceId, subjectType: 'api_key', subjectId: row.id, subjectName: row.name, action: 'api_key.revoked', reason: note, ip: actor.ip ?? null, details: { reason } });
    await this.analytics.track(tx, 'keys.key.revoked', { kind: row.kind, reason }, { userId: actor.actorId ?? undefined, workspaceId });
    await this.notifier.keyEvent(tx, reason === 'leaked' ? 'key.leaked' : 'key.revoked', { id: row.id, name: row.name, userId: row.userId, workspaceId }, { reasonLabelKey: `keys.revokeReason.${reason}`, source: note ?? '' }, { actorId: actor.actorId });
    return updated;
  }

  // ------------------------------------------------------------
  // Утечки и validity-check
  // ------------------------------------------------------------

  /** Сигнал сканера: найденные ключи отзываются (reason leaked) — без раскрытия владельца в ответе. */
  async leaked(items: KeysLeakedInput): Promise<{ revoked: number }> {
    const peppers = await this.mac.pepperVersions();
    let revoked = 0;
    for (const item of items) {
      const parsed = parseApiSecret(item.token);
      if (!parsed || parsed.kind === 'whs') continue;
      const hashes = peppers.map((p) => hashApiSecret(p.material, item.token));
      const row = await this.db.apiKey.findFirst({ where: { hash: { in: hashes } } });
      if (!row || row.revokedAt) continue;
      await this.db.$transaction((tx) => this.revokeTx(tx, row, { actorId: null, actorKind: 'system' }, 'leaked', item.source ?? item.url ?? 'scanner'));
      revoked++;
    }
    return { revoked };
  }

  /** Жив ли ключ (без владельца и скоупов): константное время на пути «нет такого». */
  async verify(secret: string): Promise<ApiKeyVerifyDto> {
    const parsed = parseApiSecret(secret);
    if (!parsed || parsed.kind === 'whs') return { valid: false, kind: null };
    const peppers = await this.mac.pepperVersions();
    const hashes = peppers.map((p) => hashApiSecret(p.material, secret));
    const row = await this.db.apiKey.findFirst({ where: { hash: { in: hashes } }, include: { bot: { select: { status: true } } } });
    if (!row) return { valid: false, kind: null };
    const status = keyStatusOf(row, row.bot?.status ?? null);
    return { valid: status === 'active' || status === 'expiring', kind: parsed.kind };
  }
}
