// ============================================================
// Groups (Circle) — owner-local groupings of confirmed contacts
// ============================================================
// A Group ("Группа") belongs to ONE owner. The owner manually adds
// people (ContactLinks) into it via CircleMembership (M2M). The same
// ContactLink can appear in groups owned by BOTH sides independently.
// Each group has its own card visibility — what its members may see.

import type { Contact } from './contact';
import type { CardVisibility } from './user';
import type { CalendarAccessLevel } from './calendar';

export interface Circle {
  id: string;
  ownerId: string;
  name: string; // "Семья", "Родственники", "Работа", custom
  icon: string | null;
  color: string | null;
  sortOrder: number;
  membersCount: number;
  // Card visibility applied to members of THIS group (resolved/full).
  cardVisibility: CardVisibility;
  // Calendar access this group's members get to the owner's calendar (Phase 2).
  calendarVisibility: CalendarAccessLevel;
  createdAt: string;
  updatedAt: string;
}

export interface CircleWithMembers extends Circle {
  members: Contact[];
}

// ============================================================
// Requests (DTOs)
// ============================================================
