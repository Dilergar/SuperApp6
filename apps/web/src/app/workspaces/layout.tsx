// Серверная обёртка области организации: словарь КАРКАСА области и ничего больше.
// Каркас (`[id]/workspace-chrome.tsx`) рисует только сигнал тарифа — `entitlements`;
// меню сервисов и шапка живут в корневом layout и берут `common` + `shell`.
//
// ⚠️ Провайдер стоит ЗДЕСЬ, а не в `[id]/layout.tsx`, потому что граница
// `workspaces/loading.tsx` оборачивает сегмент `[id]` целиком. Асинхронный
// `ServiceMessages` между границей и шлюзом авторизации каркаса приостанавливает
// её на сервере — содержимое уезжает чанком `$RC`, а в невидимой вкладке это вечный
// спиннер (docs/web_conventions.md «Маршруты и границы»). Layout сегмента выше
// своей границы — часть оболочки, сервер дожидается его до первой отправки.
//
// Словари разделов кладёт layout каждого раздела (`[id]/<раздел>/layout.tsx`,
// главная — `[id]/(home)/layout.tsx`): они ниже шлюза, сервер их не рисует.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspacesLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="entitlements">{children}</ServiceMessages>;
}
