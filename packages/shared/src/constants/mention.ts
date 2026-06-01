// Mentions Hub (Phase 5) — shared constants + token parser.

export const MENTION_SOURCE_TYPES = ['messenger', 'task', 'calendar', 'listing'] as const;

export const MENTION_LIMITS = {
  /** Max mentions honored in a single message (anti-spam). */
  maxPerMessage: 20,
  /** Hub feed page size. */
  feedPageSize: 30,
  /** Snippet length stored for the hub row. */
  snippetLength: 140,
} as const;

/**
 * Mention token embedded in authored text: `@[Display Name](userId)`.
 * The visible part is the name; the (userId) is the durable link (users have no @handle).
 * Display names can contain spaces but not `]` or `)` (the picker inserts clean names).
 */
const MENTION_TOKEN = /@\[([^\]]{1,80})\]\(([0-9a-fA-F-]{36})\)/g;

export interface ParsedMention {
  /** Resolved user id the mention points to. */
  userId: string;
  /** Display name as written at authoring time. */
  name: string;
  /** Character offset of the token start in the raw content. */
  index: number;
}

/** Extract resolved mentions from raw content (deduped by userId, capped). */
export function parseMentions(content: string): ParsedMention[] {
  if (!content) return [];
  const out: ParsedMention[] = [];
  const seen = new Set<string>();
  MENTION_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_TOKEN.exec(content)) !== null) {
    const name = m[1];
    const userId = m[2];
    if (seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, name, index: m.index });
    if (out.length >= MENTION_LIMITS.maxPerMessage) break;
  }
  return out;
}

/** Build a mention token for insertion into content. */
export function mentionToken(name: string, userId: string): string {
  return `@[${name}](${userId})`;
}
