'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth';

/**
 * Клиентский guard для защищённых страниц.
 * Если после гидрации сессии пользователь не залогинен — редиректит на /login.
 *
 * Использование:
 *   const { isReady, user } = useRequireAuth();
 *   if (!isReady) return <Loading />;
 *   // далее user гарантированно не null
 */
export function useRequireAuth() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isHydrated = useAuthStore((s) => s.isHydrated);

  useEffect(() => {
    if (isHydrated && !isAuthenticated) {
      router.push('/login');
    }
  }, [isHydrated, isAuthenticated, router]);

  return {
    isReady: isHydrated && isAuthenticated && user !== null,
    user,
  };
}
