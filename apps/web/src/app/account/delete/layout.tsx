import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Мастер удаления аккаунта живёт ВНЕ профиля намеренно: сюда ведёт «Не принимаю» с блокирующего
// экрана согласий, а за шлюзом профиль не работает (его запросы отвечают 403 consents.pending).
// Страница зовёт только маршруты белого списка шлюза: блокеры, SMS-подтверждение, удаление.
export default function AccountDeleteLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['consents', 'auth']}>{children}</ServiceMessages>;
}
