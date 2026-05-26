// ============================================================
// CALENDAR — types
// ============================================================
// Phase 1 (core): personal calendar. Events with RRULE recurrence,
// per-occurrence reminders, all-day, location, color. Tasks are surfaced
// as a VIRTUAL layer (read live from the Tasks module, never copied).
// `visibility` is stored now; its sharing semantics are wired in Phase 2.

import type { TaskStatus, TaskPriority, TaskRole } from './task';

/** Per-event privacy override relative to the owner's group/person sharing (Phase 2). */
export type CalendarEventVisibility = 'inherit' | 'busy' | 'hidden';

/** Which instances a create/update/delete on a recurring event affects. */
export type RecurrenceEditScope = 'this' | 'this_and_following' | 'all';

/** Toggleable layers shown on the grid. */
export type CalendarLayer = 'events' | 'tasks';

/** Participant role on a shared event. The creator is the organizer (implicit). */
export type ParticipantRole = 'organizer' | 'attendee';

/** RSVP answer. `pending` = invited, not answered yet (default). */
export type RsvpStatus = 'pending' | 'accepted' | 'declined' | 'tentative';

/** Kind of a bookable resource (Phase 3). */
export type ResourceType = 'room' | 'vehicle' | 'equipment' | 'other';

/** Status of a resource booking. pending soft-holds the slot until the owner confirms. */
export type ResourceBookingStatus = 'pending' | 'confirmed' | 'rejected';

/** The stored calendar event (master, standalone, or a single-occurrence override). */
export interface CalendarEvent {
  id: string;
  userId: string;

  title: string;
  description: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
  color: string | null;

  visibility: CalendarEventVisibility;
  reminderOffsets: number[]; // minutes before start

  // Recurrence (RRULE). Master rows carry recurrenceRule; override rows carry
  // recurrenceParentId + recurrenceId (the original occurrence start they replace).
  recurrenceRule: string | null;
  recurrenceParentId: string | null;
  recurrenceId: string | null;

  // Resource booking (Phase 3): the resource this event holds, and the booking status.
  resourceId: string | null;
  resourceStatus: ResourceBookingStatus | null;

  createdAt: string;
  updatedAt: string;
}

/** One concrete instance of an event within a queried range (recurrence expanded). */
export interface CalendarEventOccurrence {
  kind: 'event';
  /** id of the concrete row (override row id, or the master/standalone id). */
  eventId: string;
  /** master id when this belongs to a recurring series, else null. */
  seriesId: string | null;
  /** original occurrence start (used for series-scoped edits/deletes). */
  occurrenceStart: string;
  recurring: boolean;

  title: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  color: string | null;
  visibility: CalendarEventVisibility;
  reminderOffsets: number[];
  /** master's RRULE when part of a series (null for standalone / single-occurrence overrides). */
  recurrenceRule: string | null;

  // ---- Phase 2 (social) ----
  /** owner (creator) of the event. */
  ownerId: string;
  /** owner display name when this is someone else's event (overlay layer); null for your own. */
  ownerName: string | null;
  /** true = render as an opaque "Занят" block (overlay at 'busy' access; details stripped). */
  busy: boolean;
  /** your RSVP if you're a participant of this event, else null. */
  myRsvp: RsvpStatus | null;
  /** number of invited attendees (excl. organizer). */
  attendeeCount: number;

  // ---- Phase 3 (resources) ----
  /** the resource this event holds, if any. */
  resourceId: string | null;
  resourceName: string | null;
  resourceStatus: ResourceBookingStatus | null;
}

/** A task surfaced on the calendar as a layer item (not a stored event). */
export interface CalendarTaskItem {
  kind: 'task';
  taskId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** display slot start (dueDate, or today when overdue+pinned). */
  start: string;
  end: string;
  allDay: boolean;
  dueDate: string;
  /** true when past-due & unresolved → pinned to today's all-day bar. */
  overdue: boolean;
  myRole: TaskRole | 'creator' | null;
  coinReward: number | null;
}

export type CalendarItem = CalendarEventOccurrence | CalendarTaskItem;

export interface CalendarRangeResponse {
  items: CalendarItem[];
}

// ---- Requests ----

export interface CreateCalendarEventRequest {
  title: string;
  description?: string;
  location?: string;
  startTime: string;
  endTime: string;
  allDay?: boolean;
  color?: string;
  visibility?: CalendarEventVisibility;
  reminderOffsets?: number[];
  recurrenceRule?: string;
  /** invite at creation (from environment): people and/or a Group snapshot. */
  participantUserIds?: string[];
  participantCircleId?: string;
  /** attach (book) a resource on creation. */
  resourceId?: string;
}

export interface UpdateCalendarEventRequest {
  title?: string;
  description?: string | null;
  location?: string | null;
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
  color?: string | null;
  visibility?: CalendarEventVisibility;
  reminderOffsets?: number[];
  recurrenceRule?: string | null;
  /** attach/detach a resource booking (null = detach). */
  resourceId?: string | null;
  /** For recurring events: which instances this edit affects (default 'all'). */
  editScope?: RecurrenceEditScope;
  /** Original occurrence start; required when editScope is 'this' or 'this_and_following'. */
  occurrenceStart?: string;
}

export interface CalendarRangeQuery {
  from: string;
  to: string;
  layers?: CalendarLayer[];
}

// ---- Sharing (Phase 2 — model kept for forward-compat) ----

/** Access level a viewer has to someone's calendar. Ordered: none < busy < detailed. */
export type CalendarAccessLevel = 'none' | 'busy' | 'detailed';

/** Person-level grant: someone you've shared your calendar with, at a level. */
export interface CalendarShare {
  sharedWithUserId: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  accessLevel: Exclude<CalendarAccessLevel, 'none'>; // 'busy' | 'detailed'
  createdAt: string;
}

/** A person whose calendar I may view — surfaced as a toggleable layer. */
export interface SharedCalendarSource {
  userId: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  accessLevel: Exclude<CalendarAccessLevel, 'none'>;
}

export interface EventParticipant {
  userId: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  role: ParticipantRole;
  rsvp: RsvpStatus;
}

/** Full event detail (GET /calendar/events/:id) — opens the editor/card with participants. */
export interface CalendarEventDetail extends CalendarEvent {
  isOrganizer: boolean;
  myRsvp: RsvpStatus | null;
  participants: EventParticipant[];
  /** booked resource name (if any) + whether the viewer owns that resource (can confirm/reject). */
  resourceName: string | null;
  isResourceOwner: boolean;
}

export interface InviteParticipantsRequest {
  userIds?: string[];
  circleId?: string;
}

export interface RsvpRequest {
  status: 'accepted' | 'declined' | 'tentative';
}

export interface SetCalendarShareRequest {
  sharedWithUserId: string;
  accessLevel: Exclude<CalendarAccessLevel, 'none'>;
}

export interface SmartMatchRequest {
  userIds: string[];
  durationMin: number;
  from: string;
  to: string;
  /** minutes from midnight bounding the day window (default 540–1260 = 09:00–21:00). */
  dayStartMin?: number;
  dayEndMin?: number;
}

export interface SmartMatchSlot {
  start: string;
  end: string;
}

export interface SmartMatchResponse {
  slots: SmartMatchSlot[];
}

// ---- Phase 3 (resources) ----

/** A bookable shared resource (room, vehicle, equipment). Personal for now (owner = user). */
export interface Resource {
  id: string;
  ownerId: string;
  name: string;
  type: ResourceType;
  capacity: number;
  /** allow-list: specific people + Groups from the owner's environment who may book. */
  bookerUserIds: string[];
  bookerCircleIds: string[];
  /** computed for the viewer. */
  isOwner: boolean;
  canBook: boolean;
  createdAt: string;
}

export interface CreateResourceRequest {
  name: string;
  type?: ResourceType;
  capacity?: number;
  bookerUserIds?: string[];
  bookerCircleIds?: string[];
}

export interface UpdateResourceRequest {
  name?: string;
  type?: ResourceType;
  capacity?: number;
  bookerUserIds?: string[];
  bookerCircleIds?: string[];
}

/** A booking of a resource — the owner's incoming-requests / schedule view. */
export interface ResourceBooking {
  eventId: string;
  resourceId: string;
  resourceName: string;
  title: string;
  start: string;
  end: string;
  bookerId: string;
  bookerName: string;
  status: ResourceBookingStatus;
}
