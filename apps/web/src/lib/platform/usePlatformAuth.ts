'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { PlatformCapability } from '@superapp/shared';
import { usePlatformAuthStore } from '@/lib/stores/platform-auth';

const LOGIN_PATH = '/platform/login';

/**
 * Гард страниц кабинета: гидрирует сессию, аноним уезжает на вход с возвратом,
 * даёт `can(cap)` и живой флаг sudo (тикает раз в 15 с — чип обратного отсчёта).
 */
export function usePlatformAuth(opts: { redirect?: boolean } = {}) {
  const redirect = opts.redirect ?? true;
  const router = useRouter();
  const pathname = usePathname();
  const me = usePlatformAuthStore((s) => s.me);
  const status = usePlatformAuthStore((s) => s.status);
  const hydrate = usePlatformAuthStore((s) => s.hydrate);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status === 'idle') void hydrate();
  }, [status, hydrate]);

  useEffect(() => {
    if (!redirect || status !== 'anonymous' || pathname === LOGIN_PATH) return;
    router.replace(`${LOGIN_PATH}?next=${encodeURIComponent(pathname)}`);
  }, [redirect, status, pathname, router]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const can = useCallback((cap: PlatformCapability) => !!me?.capabilities.includes(cap), [me]);
  const sudoUntil = me?.sudoUntil ? new Date(me.sudoUntil).getTime() : null;
  const sudoActive = !!sudoUntil && sudoUntil > now;
  const sudoLeftSec = sudoActive && sudoUntil ? Math.max(0, Math.round((sudoUntil - now) / 1000)) : 0;

  return { me, status, isReady: status === 'ready' && !!me, can, sudoActive, sudoLeftSec };
}
