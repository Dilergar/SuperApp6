import type { SocialLinks } from './user';
import type { Guarded } from '../visibility/types';

// ============================================================
// Bilateral confirmed social graph (Окружение)
// ============================================================
// A ContactLink is a confirmed connection between two users.
// From the point of view of any requesting user, we present it as:
//   { them: {...}, myRole, theirRole, ... }
// so clients do not deal with canonical (userA, userB) ordering.
//
// Each side assigns exactly ONE role to the other — asymmetric:
// you call them "Жена", they call you "Муж". The role is the real-life
// role and is shown on the card. There is NO separate category /
// "label" concept anymore.

/**
 * Карточка человека глазами ЗРИТЕЛЯ (тип `user.card` движка видимости, core/visibility):
 * каждое поле — `Guarded<T>` (значение / маска / скрыто) по ЛИЧНОЙ политике самого человека
 * (решает только он: Все · Окружение · Группы · коллеги · исключения). `null` — «пусто»,
 * маркер — «есть, но не для вас». Имя видно всегда; фамилия посторонним — инициалом.
 */
export interface ContactUserCard {
  id: string;
  firstName: string;
  lastName: Guarded<string | null>;
  avatar: Guarded<string | null>;
  /** Личный номер: связанному при «скрыто» — маска, постороннему — скрыт целиком */
  phone: Guarded<string>;
  /** Целиком `YYYY-MM-DD`; маска `--MM-DD` (год скрыт) или `YYYY` (день и месяц скрыты) */
  dateOfBirth: Guarded<string | null>;
  /** Производное года рождения: виден ровно тогда, когда виден год */
  age: Guarded<number | null>;
  bio: Guarded<string | null>;
  city: Guarded<string | null>;
  email: Guarded<string | null>;
  maritalStatus: Guarded<string | null>;
  /** Та же форма, что в анкете (`User.socialLinks`) — все 4 сети */
  socialLinks: Guarded<SocialLinks | null>;
  /** «Был в сети»: `true` — точно; маска `time_bucket` — только корзина; скрыто — никак */
  showOnlineStatus: Guarded<boolean>;
}

export interface Contact {
  // Unique id of the underlying ContactLink row.
  linkId: string;
  // The other party, from the requesting user's perspective.
  them: ContactUserCard;
  // The role I assigned to them (shown on my card, e.g. "Жена").
  myRole: string | null;
  // The role they assigned to me (so I know how they see me, e.g. "Муж").
  theirRole: string | null;
  // Which user originated the invitation that became this link.
  initiatedBy: string;
  confirmedAt: string;
  // Groups of MINE that this contact is a member of.
  myCircleIds: string[];
}

// ============================================================
// Invitations (pending requests)
// ============================================================

export type InvitationStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface ContactInvitation {
  id: string;
  fromUserId: string;
  toUserId: string | null; // null when recipient is not yet on the platform
  toPhone: string;
  // Roles each side proposes. Recipient can override both at accept time.
  proposedRoleForSender: string | null; // role the recipient gives the sender
  proposedRoleForRecipient: string | null; // role the sender gives the recipient
  message: string | null;
  status: InvitationStatus;
  /** Группы отправителя, куда контакт ляжет при принятии (его отложенное намерение). */
  autoAddToCircleIds?: string[];
  expiresAt: string;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Invitation enriched with the sender's public card (for "received" list)
export interface IncomingInvitation extends ContactInvitation {
  from: ContactUserCard;
}

// Invitation enriched with recipient info (for "sent" list)
export interface OutgoingInvitation extends ContactInvitation {
  // Null when recipient hasn't registered yet — then we only show `toPhone`.
  to: ContactUserCard | null;
  /**
   * Можно ли прямо сейчас отправить это приглашение повторно (не-pending,
   * не принятое и кулдаун истёк). Считает сервер — клиент не должен
   * восстанавливать это правило по статусу и датам.
   */
  canResend: boolean;
}

// ============================================================
// Requests (DTOs coming from clients)
// ============================================================

// Вход принятия приглашения описан Zod-схемой `acceptInvitationSchema`
// (→ `AcceptInvitationInput`): роли получателя + Группы, куда положить контакт.

// ============================================================
// Blocks
// ============================================================

export interface ContactBlockRecord {
  id: string;
  blockedUserId: string;
  blockedPhone: string;
  blockedFirstName: string | null;
  /** Masked to an initial ("Н.") — the link is gone, the full name is not exposed. */
  blockedLastName: string | null;
  blockedAvatar: string | null;
  createdAt: string;
}
