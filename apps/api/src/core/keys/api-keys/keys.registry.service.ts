import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  KEYS_LIMITS,
  type KeyAuditPage,
  type KeyJournalQuery,
  type KeyPolicyUpdateInput,
  type KeyRegistryPage,
  type KeyRegistryQuery,
  type KeyRegistryRowDto,
  type KeysPendingDto,
  type WorkspaceKeyPolicyDto,
} from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { forbidden } from '../../../shared/errors/api-error';
import { KeysAuditService } from '../keys.audit.service';
import { allowlistOf, keyStatusOf, scopesOf } from './api-keys.common';
import { ApiKeysService, type KeyActor } from './api-keys.service';
import { BotsService } from './bots.service';
import { WebhooksRegistryPort } from './webhooks.port';
import { keyActorsLite } from '../keys.audit.service';

/**
 * Реестр ключей организации (решение грилла №12): одна таблица на боты / личные ключи /
 * вебхуки — название, тип, кто создал, когда, для чего, скоупы, статус, последнее
 * использование, срок; фильтры «замороженные», «не использовались 90 дней», «без срока»,
 * «истекают за 14 дней»; вкладка «Журнал». Объём реестра ограничен тарифом (боты, ключи),
 * поэтому сортировка по последнему использованию делается в памяти, страница — смещением
 * в курсоре (keyset по nullable-колонке в Prisma врёт — записанная ловушка).
 */
@Injectable()
export class KeysRegistryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly keys: ApiKeysService,
    private readonly bots: BotsService,
    private readonly audit: KeysAuditService,
    private readonly webhooks: WebhooksRegistryPort,
  ) {}

  async list(actor: KeyActor, workspaceId: string, q: KeyRegistryQuery): Promise<KeyRegistryPage> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const now = Date.now();
    const rows: KeyRegistryRowDto[] = [];
    if (!q.kind || q.kind === 'bot' || q.kind === 'personal') {
      const keys = await this.db.apiKey.findMany({
        where: q.kind === 'bot' ? { bot: { workspaceId } } : q.kind === 'personal' ? { kind: 'pat', workspaceId } : { OR: [{ bot: { workspaceId } }, { kind: 'pat', workspaceId }] },
        include: { bot: { select: { id: true, name: true, glyph: true, status: true, frozenReason: true } } },
        take: 500,
      });
      for (const k of keys) {
        const holder: KeyRegistryRowDto['holder'] = k.bot
          ? { kind: 'bot', id: k.bot.id, name: k.bot.name, glyph: k.bot.glyph }
          : { kind: 'personal', id: k.userId ?? '', name: '', person: null };
        const scopes = scopesOf(k.scopes, k.kind === 'bot');
        const status = keyStatusOf(k, k.bot?.status ?? null, now);
        rows.push({
          kind: k.bot ? 'bot' : 'personal',
          id: k.id,
          name: k.name,
          holder,
          createdById: k.createdById,
          createdBy: null,
          createdAt: k.createdAt.toISOString(),
          purpose: k.purpose,
          scopeCount: Object.keys(scopes).length,
          scopes,
          status,
          expiresInDays: k.expiresAt ? Math.max(0, Math.ceil((k.expiresAt.getTime() - now) / 86_400_000)) : null,
          expiresAt: k.expiresAt?.toISOString() ?? null,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          lastUsedLocation: k.lastUsedCountry ?? null,
          lastUsedIp: k.lastUsedIp ?? null,
          frozenReason: (k.bot?.status === 'frozen' ? (k.bot.frozenReason as KeyRegistryRowDto['frozenReason']) : null) ?? null,
          botId: k.botId,
        });
      }
    }
    if (!q.kind || q.kind === 'webhook') rows.push(...(await this.webhooks.registryRows(workspaceId)));
    // Люди строк (владельцы личных ключей, создатели) — одним запросом, карточкой в DTO
    const personIds = new Set<string>();
    for (const r of rows) {
      if (r.holder.kind === 'personal' && r.holder.id) personIds.add(r.holder.id);
      if (r.createdById) personIds.add(r.createdById);
    }
    const people = await keyActorsLite(this.db, [...personIds]);
    for (const r of rows) {
      if (r.holder.kind === 'personal') {
        const p = people[r.holder.id];
        r.holder.person = p ?? null;
        r.holder.name = p ? [p.firstName, p.lastName].filter(Boolean).join(' ') : r.holder.name;
      }
      r.createdBy = r.createdById ? people[r.createdById] ?? null : null;
    }

    const filtered = rows.filter((r) => {
      switch (q.filter) {
        case 'frozen':
          return r.status === 'frozen';
        case 'idle90':
          return r.status !== 'revoked' && (!r.lastUsedAt || now - Date.parse(r.lastUsedAt) > KEYS_LIMITS.idleDays * 86_400_000);
        case 'noExpiry':
          return r.expiresAt === null && r.kind !== 'webhook';
        case 'expiring14':
          return r.status === 'expiring';
        default:
          return true;
      }
    });
    filtered.sort((a, b) => {
      const la = a.lastUsedAt ? Date.parse(a.lastUsedAt) : -1;
      const lb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : -1;
      if (lb !== la) return lb - la;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    const limit = q.limit ?? KEYS_LIMITS.registryPageSize;
    const offset = q.cursor ? Math.max(0, Number(Buffer.from(q.cursor, 'base64url').toString()) || 0) : 0;
    const page = filtered.slice(offset, offset + limit);
    const next = offset + limit < filtered.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
    return { items: page, nextCursor: next };
  }

  async pending(actor: KeyActor, workspaceId: string): Promise<KeysPendingDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    return { frozenBots: await this.bots.pending(workspaceId) };
  }

  async journal(actor: KeyActor, workspaceId: string, q: KeyJournalQuery): Promise<KeyAuditPage> {
    await this.keys.assertManager(actor.userId, workspaceId);
    return this.audit.list(workspaceId, q);
  }

  async policyOf(actor: KeyActor, workspaceId: string): Promise<WorkspaceKeyPolicyDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    return this.keys.toPolicyDto(await this.keys.policy(workspaceId));
  }

  /** Политика — только владелец (потолки сроков и обязательность IP-списка). */
  async updatePolicy(actor: KeyActor, workspaceId: string, input: KeyPolicyUpdateInput): Promise<WorkspaceKeyPolicyDto> {
    const role = await this.keys.assertManager(actor.userId, workspaceId);
    if (role !== 'owner') throw forbidden('keys.role_required', undefined, { code: 'keys.role_required' });
    const row = await this.db.$transaction(async (tx) => {
      const p = await tx.workspaceKeyPolicy.upsert({
        where: { workspaceId },
        create: { workspaceId, ...(input.maxPatDays !== undefined ? { maxPatDays: input.maxPatDays } : {}), ...(input.maxBotKeyDays !== undefined ? { maxBotKeyDays: input.maxBotKeyDays } : {}), ...(input.requireIpAllowlist !== undefined ? { requireIpAllowlist: input.requireIpAllowlist } : {}) },
        update: { ...(input.maxPatDays !== undefined ? { maxPatDays: input.maxPatDays } : {}), ...(input.maxBotKeyDays !== undefined ? { maxBotKeyDays: input.maxBotKeyDays } : {}), ...(input.requireIpAllowlist !== undefined ? { requireIpAllowlist: input.requireIpAllowlist } : {}) },
      });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'policy', subjectId: workspaceId, subjectName: 'key policy', action: 'policy.updated', ip: actor.ip ?? null, details: input as Prisma.InputJsonObject });
      return p;
    });
    return this.keys.toPolicyDto(row);
  }
}
