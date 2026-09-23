// Серверная обёртка: каталоги Диска организации.
// `share` — ссылки наружу, `entitlements` — замки тарифа, `circles` — окно доступа рисует людей карточками.
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceDriveLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['drive', 'share', 'entitlements', 'circles']}>{children}</ServiceMessages>;
}
