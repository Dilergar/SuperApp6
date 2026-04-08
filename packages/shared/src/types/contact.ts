// ============================================================
// Bilateral confirmed social graph
// ============================================================
// A ContactLink is a confirmed connection between two users.
// From the point of view of any requesting user `me`, we present it as:
//   { me: {...}, them: {...}, myLabelForThem, theirLabelForMe, ... }
// so clients do not have to deal with canonical (userA, userB) ordering.

export type RelationshipType =
  | 'family' // parents, siblings, children, grandparents
  | 'romantic' // spouse, partner
  | 'friend' // friend, close friend
  | 'professional' // colleague, boss, report, client
  | 'acquaintance' // neighbor, gym buddy, one-off
  | 'other';

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
  socialLinks: { telegram?: string; instagram?: string } | null;
  // Visibility is resolved per-request — the server applies
  // the card owner's cardVisibility. Hidden fields returned as null.
}

export interface Contact {
  // Unique id of the underlying ContactLink row.
  linkId: string;
  // Relationship category (broad bucket).
  relationshipType: RelationshipType;
  // The other party, from the requesting user's perspective.
  them: ContactUserCard;
  // How I labeled them (shown on my card for them, e.g. "жена").
  myLabelForThem: string | null;
  // How they labeled me (shown on their card for me, e.g. "муж").
  // Visible to me so I know how they see me.
  theirLabelForMe: string | null;
  // Which user originated the invitation that became this link.
  initiatedBy: string;
  confirmedAt: string;
  // Circles of MINE that this contact is a member of.
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
  // Labels each side proposes. Recipient can override both at accept time.
  proposedLabelForSender: string | null; // how recipient should call sender
  proposedLabelForRecipient: string | null; // how sender wants to call recipient
  relationshipType: RelationshipType;
  message: string | null;
  status: InvitationStatus;
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
}

// ============================================================
// Requests (DTOs coming from clients)
// ============================================================

export interface SendInvitationRequest {
  toPhone: string;
  relationshipType: RelationshipType;
  proposedLabelForRecipient?: string; // how I will call them on my card
  proposedLabelForSender?: string; // suggestion for how they should call me
  message?: string;
  // Circles of mine to auto-add the new contact into upon acceptance.
  autoAddToCircleIds?: string[];
}

export interface AcceptInvitationRequest {
  // Recipient can override what the sender proposed, or keep them.
  myLabelForThem?: string; // how recipient (me) will call sender
  theirLabelForMe?: string; // how sender will call me
  relationshipType?: RelationshipType;
  // Circles of mine (recipient's) to place the new contact into.
  autoAddToCircleIds?: string[];
}

export interface UpdateContactRequest {
  myLabelForThem?: string | null;
  relationshipType?: RelationshipType;
}

// ============================================================
// Blocks
// ============================================================

export interface ContactBlockRecord {
  id: string;
  blockedUserId: string;
  blockedPhone: string;
  blockedFirstName: string | null;
  createdAt: string;
}

export interface BlockUserRequest {
  userId: string;
}
