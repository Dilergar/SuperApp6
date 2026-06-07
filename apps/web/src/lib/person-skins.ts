'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { CardSkinRender } from '@superapp/shared';

// ============================================================
// Person-skin engine — resolve & cache the skin each person has
// equipped FOR ME, so any "person" surface (chat list, pickers,
// task participants, mentions, search) can show their skin with a
// single hook. Batched (one /resolve request per tick) + cached.
// ============================================================

const cache = new Map<string, CardSkinRender | null>();
const inflight = new Set<string>();
let queue = new Set<string>();
let scheduled = false;
const subs = new Set<() => void>();
// Ids currently needed by mounted hooks (ref-counted) — so invalidate() can
// re-fetch exactly what's on screen instead of leaving it on the default skin.
const active = new Map<string, number>();

function notify() {
  for (const f of subs) f();
}

async function flush() {
  scheduled = false;
  const ids = [...queue].filter((id) => !cache.has(id) && !inflight.has(id));
  queue = new Set();
  if (ids.length === 0) return;
  ids.forEach((id) => inflight.add(id));
  try {
    const res = await api.get('/card-skins/resolve', { params: { userIds: ids.join(',') } });
    const map = (res.data?.data ?? {}) as Record<string, CardSkinRender | null>;
    for (const id of ids) cache.set(id, map[id] ?? null);
  } catch {
    // Network blip — DON'T cache null (that would pin the default skin forever);
    // leaving ids uncached lets a later request()/invalidate retry them.
  } finally {
    ids.forEach((id) => inflight.delete(id));
    notify();
  }
}

function request(ids: string[]) {
  let added = false;
  for (const id of ids) {
    if (id && !cache.has(id) && !inflight.has(id)) {
      queue.add(id);
      added = true;
    }
  }
  if (added && !scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
}

/** Resolve skins for a set of people. Returns { userId: skin | null }. */
export function usePersonSkins(userIds: (string | undefined | null)[]): Record<string, CardSkinRender | null> {
  const [, force] = useState(0);
  const ids = userIds.filter(Boolean) as string[];
  const key = ids.join(',');

  useEffect(() => {
    const cb = () => force((n) => n + 1);
    subs.add(cb);
    retain(ids);
    request(ids);
    return () => {
      subs.delete(cb);
      release(ids);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const out: Record<string, CardSkinRender | null> = {};
  for (const id of ids) out[id] = cache.get(id) ?? null;
  return out;
}

/** Resolve the skin for a single person. */
export function usePersonSkin(userId?: string | null): CardSkinRender | null {
  const map = usePersonSkins([userId]);
  return userId ? map[userId] ?? null : null;
}

function retain(ids: string[]) {
  for (const id of ids) active.set(id, (active.get(id) ?? 0) + 1);
}
function release(ids: string[]) {
  for (const id of ids) {
    const n = (active.get(id) ?? 0) - 1;
    if (n <= 0) active.delete(id);
    else active.set(id, n);
  }
}

/**
 * Drop the cache (e.g. right after the user equips/unequips a skin) AND
 * immediately re-fetch every skin still on screen, so avatars refresh in place
 * instead of falling back to the default until the next remount.
 */
export function invalidatePersonSkins() {
  cache.clear();
  inflight.clear();
  request([...active.keys()]);
  notify();
}
