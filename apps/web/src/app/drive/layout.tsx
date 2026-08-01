// Сервер-layout Диска: cookie сайдбара читается уровнем выше (AppChrome), здесь
// нужен только Suspense — DriveShell использует useSearchParams (?space=/?ws=).
//
// ⚠️ Сервер под этой границей НЕ рисует содержимого: авторизация у нас клиентская,
// и большой серверный HTML под Suspense уезжает отдельным чанком, который в НЕВИДИМОЙ
// вкладке раскрывается по requestAnimationFrame — то есть никогда.

import { Suspense } from 'react';
import RouteLoading from '@/components/shell/RouteLoading';
import { DriveShell } from './drive-shell';

export default function DriveLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<RouteLoading />}>
      <DriveShell>{children}</DriveShell>
    </Suspense>
  );
}
