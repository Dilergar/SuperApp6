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
  onlineStatusMode: string; // everyone, contacts, nobody
  isVerified: boolean;
  locale: string;
  timezone: string;
  // ---- Реквизиты («Моя Анкета» → блок «Для договоров и трудоустройства») ----
  // В личном окружении (Группы) НЕ показываются; коллегам — по тумблерам
  // companyCardVisibility.extras (по умолчанию скрыты); управляющим организаций —
  // всегда (нередактируемый уровень «Видимости в Компаниях»).
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
  activeSubscription: SubscriptionInfo | null;
  /** Owner's DEFAULT card visibility — applied to contacts that are in
   *  none of the owner's groups. Per-group visibility lives on Circle. */
  cardVisibility: CardVisibility;
  /** «Видимость в Компаниях» — что видят коллеги по организации (ростер «Сотрудники»). */
  companyCardVisibility: CardVisibility;
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
  phone: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

export interface SubscriptionInfo {
  // `id` здесь НЕТ намеренно: select профиля его не берёт, и провод его никогда не слал.
  plan: 'free' | 'personal' | 'family' | 'business';
  status: 'active' | 'trial' | 'expired' | 'cancelled';
  expiresAt: string;
  giftedBy: string | null;
}

// ============================================================
// Contact card visibility
// ============================================================
// Always-visible on your card (regardless of flags):
//   firstName, lastName, phone, role (the label your contact gave you)
// Everything else is per-field toggleable by the card owner.
// A `null` stored in DB means "use defaults" — resolver in API merges with DEFAULT_CARD_VISIBILITY.

export interface CardVisibility {
  dateOfBirth: boolean;
  age: boolean;
  onlineStatus: boolean;
  maritalStatus: boolean;
  city: boolean;
  bio: boolean;
  email: boolean;
  socialLinks: boolean;
  // Future-proof extension bag — per-field flags added later without schema migration
  extras?: Record<string, boolean>;
}
