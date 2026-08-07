import type { SocialLinks } from './user';

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

export interface ContactUserCard {
  id: string;
  phone: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  dateOfBirth: string | null;
  bio: string | null;
  city: string | null;
  email: string | null;
  maritalStatus: string | null;
  /** Та же форма, что в анкете (`User.socialLinks`): сервер принимает и хранит 4 сети,
   *  и все 4 доезжают до карточки. Узкая копия `{telegram?, instagram?}` делала
   *  LinkedIn и WhatsApp write-only данными — их писали и никогда не показывали. */
  socialLinks: SocialLinks | null;
  age: number | null; // calculated on backend, null if owner hides it
  showOnlineStatus: boolean; // true if card owner allows online status visible
  // Visibility is resolved per-request from the viewer's group(s) on the
  // card owner's side (union); falls back to the owner's default. Hidden
  // fields are returned as null.
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
