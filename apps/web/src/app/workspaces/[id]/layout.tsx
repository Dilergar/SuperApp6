// Серверная обёртка области организации — СИНХРОННАЯ, без провайдера словаря.
//
// ⚠️ Сюда нельзя класть `ServiceMessages` и вообще ничего асинхронного: этот
// сегмент лежит под границей `workspaces/loading.tsx`, и всё асинхронное ВЫШЕ
// шлюза авторизации каркаса сервер обязан дождаться — граница приостанавливается,
// содержимое уезжает чанком `$RC` (вечный спиннер в невидимой вкладке). Словарь
// каркаса — уровнем выше (`app/workspaces/layout.tsx`), словари разделов — в их
// собственных layout'ах ниже шлюза (сервер их не рисует: авторизация клиентская).
//
// Сам каркас — клиентский (адрес организации, проверка входа), поэтому он вынесен
// в `workspace-chrome.tsx`.

import type { ReactNode } from 'react';
import { WorkspaceChrome } from './workspace-chrome';

export default function WorkspaceAreaLayout({ children }: { children: ReactNode }) {
  return <WorkspaceChrome>{children}</WorkspaceChrome>;
}
