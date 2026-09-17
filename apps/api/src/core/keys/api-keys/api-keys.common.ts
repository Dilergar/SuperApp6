import type { ApiKey, Bot } from '@prisma/client';
import { KEYS_LIMITS, ipAllowed, normalizeKeyScopes, type ApiKeyDto, type ApiKeyStatus, type BotDto, type KeyScopes } from '@superapp/shared';
import { isDevEnv } from '../../../shared/config/env.validation';

/** Среда в теле ключа: `test` в development/test, `live` — в production. */
export const apiKeyEnv = (): 'live' | 'test' => (isDevEnv() ? 'test' : 'live');

export function keyStatusOf(row: Pick<ApiKey, 'revokedAt' | 'expiresAt' | 'graceUntil'>, botStatus: string | null, now = Date.now()): ApiKeyStatus {
  if (row.revokedAt) return 'revoked';
  if (row.graceUntil && row.graceUntil.getTime() <= now) return 'expired';
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired';
  if (botStatus === 'frozen') return 'frozen';
  if (row.expiresAt && row.expiresAt.getTime() - now < KEYS_LIMITS.expiringDays * 86_400_000) return 'expiring';
  return 'active';
}

/** Живой ключ: не отозван, не истёк, grace не прошёл. */
export function keyIsLive(row: Pick<ApiKey, 'revokedAt' | 'expiresAt' | 'graceUntil'>, now = Date.now()): boolean {
  if (row.revokedAt) return false;
  if (row.graceUntil && row.graceUntil.getTime() <= now) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= now) return false;
  return true;
}

export function scopesOf(json: unknown, forBot: boolean): KeyScopes {
  return normalizeKeyScopes((json ?? {}) as Record<string, unknown>, forBot);
}

export function allowlistOf(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((v): v is string => typeof v === 'string') : [];
}

export function ipAllowedBy(ip: string | null, ...lists: string[][]): boolean {
  return lists.every((l) => ipAllowed(ip, l));
}

export function toApiKeyDto(row: ApiKey, botStatus: string | null): ApiKeyDto {
  return {
    id: row.id,
    kind: row.kind as 'bot' | 'pat',
    botId: row.botId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    familyId: row.familyId,
    name: row.name,
    purpose: row.purpose,
    prefix: row.prefix,
    last4: row.last4,
    scopes: scopesOf(row.scopes, row.kind === 'bot'),
    ipAllowlist: allowlistOf(row.ipAllowlist),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedLocation: row.lastUsedCountry ?? null,
    lastUsedIp: row.lastUsedIp ?? null,
    useCount: row.useCount,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: (row.revokedReason as ApiKeyDto['revokedReason']) ?? null,
    rotatedFromId: row.rotatedFromId,
    graceUntil: row.graceUntil?.toISOString() ?? null,
    storedHint: row.storedHint,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    status: keyStatusOf(row, botStatus),
  };
}

export function toBotDto(row: Bot & { keys?: Pick<ApiKey, 'revokedAt' | 'expiresAt' | 'graceUntil'>[] }): BotDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    name: row.name,
    glyph: row.glyph,
    status: row.status as BotDto['status'],
    frozenReason: (row.frozenReason as BotDto['frozenReason']) ?? null,
    frozenAt: row.frozenAt?.toISOString() ?? null,
    rank: row.rank as BotDto['rank'],
    responsibleUserId: row.responsibleUserId,
    purpose: row.purpose,
    scopes: scopesOf(row.scopes, true),
    ipAllowlist: allowlistOf(row.ipAllowlist),
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    liveKeys: (row.keys ?? []).filter((k) => keyIsLive(k)).length,
  };
}

/** Роль бота в организации по рангу (проекция в user_roles / core/access). */
export function botRoleOfRank(rank: string): 'staff' | 'manager' {
  return rank === 'manager' ? 'manager' : 'staff';
}
