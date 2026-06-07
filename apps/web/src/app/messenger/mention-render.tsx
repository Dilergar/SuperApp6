'use client';

import { Fragment, type ReactNode } from 'react';
import { PersonChip } from '../circles/PersonCard';

// ============================================================
// Mention rendering (Phase 5). Authored text carries inline tokens
// `@[Имя](userId)`; here we turn them into highlighted chips and
// provide a plain-text fallback for previews.
// Sketchbook look: secondary-tinted rounded inline chip; if the
// mention is OF the viewer, tint it stronger (primary).
// ============================================================

// Token regex mirrors @superapp/shared's MENTION_TOKEN: `@[Name](uuid)`.
// Kept local (the shared one isn't exported) but identical in shape.
const TOKEN = /@\[([^\]]{1,80})\]\(([0-9a-fA-F-]{36})\)/g;

/**
 * Inline mention — renders the person's S card (skin avatar + name) right in the
 * message text, replacing the raw @token. A subtle outline marks a mention of me.
 */
export function MentionChip({ name, mine, userId }: { name: string; mine: boolean; userId?: string | null }) {
  return (
    <span
      style={{
        display: 'inline-flex', verticalAlign: 'middle', margin: '0 0.12rem',
        borderRadius: 'var(--radius-md)',
        outline: mine ? '2px solid var(--primary)' : undefined,
        outlineOffset: mine ? 1 : undefined,
      }}
    >
      <PersonChip size="S" userId={userId} firstName={name} />
    </span>
  );
}

/**
 * Split raw content into plain-text segments + <MentionChip> nodes.
 * `currentUserId` decides which chips read as "me" (stronger tint).
 */
export function renderMessageContent(content: string | null | undefined, currentUserId: string): ReactNode {
  if (!content) return content ?? '';
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(content)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={key++}>{content.slice(last, m.index)}</Fragment>);
    const name = m[1];
    const id = m[2];
    nodes.push(<MentionChip key={key++} name={name} mine={id === currentUserId} userId={id} />);
    last = m.index + m[0].length;
  }
  if (last === 0) return content; // no tokens → return raw string (cheapest path)
  if (last < content.length) nodes.push(<Fragment key={key++}>{content.slice(last)}</Fragment>);
  return nodes;
}

/**
 * Plain-text form for previews/snippets: turn `@[Имя](id)` into `@Имя`.
 * Used in the inbox last-message preview and the hub snippet so the raw
 * token never leaks into UI that can't render chips.
 */
export function stripMentions(content: string | null | undefined): string {
  if (!content) return '';
  return content.replace(TOKEN, (_full, name) => `@${name}`);
}
