import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Комната встречи — единственное место вне мессенджера, куда встроен его диалог
// (`Conversation`): чат встречи живёт и после её конца. Поэтому словарь мессенджера
// кладётся ЗДЕСЬ, а не в область организации: на остальных её страницах он не нужен.
//
// ЛОВУШКА: вложенный провайдер ЗАМЕНЯЕТ сообщения, а не дополняет их (docs/i18n.md),
// поэтому перечислено ВСЁ, что нужно поддереву. Каркас области (шапка, стопка
// решений) рисуется выше по дереву и своих неймспейсов не теряет. `notes` — «Заметка
// из сообщения» в меню чата встречи.
export default function MeetingRoomLayout({ children }: { children: ReactNode }) {
  return (
    <ServiceMessages ns={['office', 'calls', 'messenger', 'notes', 'circles']}>{children}</ServiceMessages>
  );
}
