'use client';

// ============================================================
// AppChrome — решает, показывать ли каркас приложения на этом адресе.
//
// Живёт в корневом layout, поэтому каркас появляется сразу на всех
// страницах, и им больше не нужно рисовать свой навбар.
//
// Без каркаса живут: вход и регистрация (человек ещё не в приложении),
// посадочная страница и полноэкранные режимы — редактор документов,
// канвас процессов и комната звонка: там каркас отнял бы рабочее поле.
// ============================================================

import { usePathname } from 'next/navigation';
import { AppShell } from './AppShell';

// /freeze — экстренная заморозка без входа (core/audit): открывается и без аккаунта, с чужого устройства
const BARE_EXACT = new Set(['/', '/login', '/register', '/reset-password', '/freeze']);

function isBare(pathname: string): boolean {
  if (BARE_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/s/')) return true;                          // гостевая ссылка: человек без аккаунта
  if (pathname === '/platform' || pathname.startsWith('/platform/')) return true; // кабинет платформы: свой каркас и свой вход
  if (pathname === '/legal' || pathname.startsWith('/legal/')) return true; // публичная витрина документов платформы (core/consents)
  if (pathname.startsWith('/account/delete')) return true;              // мастер удаления аккаунта: работает и за шлюзом согласий
  if (pathname.startsWith('/check')) return true;                       // открытая проверка подписи (ст. 61 ЦК РК)
  if (pathname.startsWith('/docs/')) return true;                       // редактор во весь экран
  if (/^\/workspaces\/[^/]+\/processes\/[^/]+$/.test(pathname)) return true; // канвас процесса
  if (/^\/workspaces\/[^/]+\/office\/[^/]+$/.test(pathname)) return true;    // комната звонка
  return false;
}

export function AppChrome({ defaultCollapsed, children }: { defaultCollapsed?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  if (isBare(pathname)) return <>{children}</>;
  return <AppShell defaultCollapsed={defaultCollapsed}>{children}</AppShell>;
}
