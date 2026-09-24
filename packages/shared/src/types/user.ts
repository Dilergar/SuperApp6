import type { Guarded } from '../visibility/types';

// ============================================================
// User, profile, contact card visibility
// ============================================================

export interface User {
  id: string;
  phone: string;
  firstName: string;
  lastName: string | null;
  /** Отчество — реквизит документов (полное ФИО в приказах); в карточках не показывается */
  middleName: string | null;
  dateOfBirth: string | null; // ISO date (YYYY-MM-DD)
  avatar: string | null;
  bio: string | null;
  city: string | null;
  email: string | null;
  maritalStatus: string | null; // single, married, relationship, divorced, widowed, null
  socialLinks: SocialLinks | null;
  isVerified: boolean;
  /** `bot` — теневой пользователь бота (core/keys): интеграция по ключу видит, кто она */
  kind: 'person' | 'bot';
  /** Язык интерфейса (BCP-47, одна из SUPPORTED_LOCALES); string на проводе — форвард-совместимость со старыми клиентами */
  locale: string;
  timezone: string;
  // ---- Реквизиты («Моя Анкета» → блок «Для договоров и трудоустройства») ----
  // Служебные поля организации (core/visibility, тип `staff.member`): кто их видит,
  // решает организация; сам человек видит своё всегда; в личном Окружении их нет.
  iin: string | null;
  residentialAddress: string | null;
  idDocNumber: string | null;
  idDocIssuedBy: string | null;
  idDocIssuedAt: string | null; // ISO date (YYYY-MM-DD)
  createdAt: string;
  updatedAt: string;
}

export interface SocialLinks {
  telegram?: string;
  instagram?: string;
  linkedin?: string;
  whatsapp?: string;
}

export interface UserProfile extends User {
  circlesCount: number;
  workspacesCount: number;
  contactsCount: number;
  roles: UserRoleInfo[];
}

export interface UserRoleInfo {
  role: string;
  context: string;
  tenantId: string | null;
}

/**
 * Ответ `GET /users/lookup?phone=` — ПРЕ-ЛИНК карточка (форма приглашения):
 * фамилия маскирована до инициала («Санжар Н.», Kaspi-стиль), больше о человеке
 * до подтверждения связи не отдаётся.
 */
export interface UserLookupDto {
  id: string;
  /** Эхо номера, который ищущий ввёл сам */
  phone: string;
  firstName: string;
  /** По правилам владельца: посторонним — инициалом */
  lastName: Guarded<string | null>;
  avatar: Guarded<string | null>;
}

// Подписка в профиле больше не живёт: тариф и лимиты отдаёт снимок
// `GET /entitlements/me` (core/entitlements, типы — `types/entitlements.ts`).

