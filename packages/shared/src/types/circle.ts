// ============================================================
// Circles — owner-local groupings ("folders") of confirmed contacts
// ============================================================
// A Circle belongs to ONE owner and is just a way to organize
// their ContactLinks (via CircleMembership M2M).
// The same ContactLink can appear in Circles owned by BOTH sides independently.

import type { Contact } from './contact';

export interface Circle {
  id: string;
  ownerId: string;
  name: string; // "Семья", "Друзья", "Работа", custom
  icon: string | null;
  color: string | null;
  sortOrder: number;
  membersCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CircleWithMembers extends Circle {
  members: Contact[];
}

// ============================================================
// Requests (DTOs)
// ============================================================

export interface CreateCircleRequest {
  name: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
}

export interface UpdateCircleRequest {
  name?: string;
  icon?: string | null;
  color?: string | null;
  sortOrder?: number;
}

export interface AddToCircleRequest {
  // The ContactLink to place into this circle.
  contactLinkId: string;
}

export interface ReorderCirclesRequest {
  circles: Array<{ id: string; sortOrder: number }>;
}
