'use client';

import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  // resize — страховка: эмуляция DevTools (и отдельные WebView) не всегда
  // диспатчит mq-change при смене метрик; снапшот всё равно перечитывается
  window.addEventListener('resize', onChange);
  return () => {
    mq.removeEventListener('change', onChange);
    window.removeEventListener('resize', onChange);
  };
}

/**
 * «Это телефон?» — тот же брейкпоинт, что у шторки каркаса (globals.css, 767px).
 * useSyncExternalStore: на сервере false (SSR-разметка десктопная, гидратация не
 * расходится), на клиенте — актуальное значение и живое обновление при повороте.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
