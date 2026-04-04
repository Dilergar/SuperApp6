export type CalendarEventType = 'event' | 'task' | 'reminder' | 'birthday';

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
  color: string | null;
  type: CalendarEventType;

  userId: string;
  taskId: string | null; // linked task

  // Google Calendar sync
  googleEventId: string | null;
  googleCalendarId: string | null;

  // Recurrence
  recurrenceRule: string | null; // RRULE format

  createdAt: string;
  updatedAt: string;
}

export interface CreateCalendarEventRequest {
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  allDay?: boolean;
  color?: string;
  type?: CalendarEventType;
  recurrenceRule?: string;
  taskId?: string;
}

export interface UpdateCalendarEventRequest {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
  color?: string;
  recurrenceRule?: string;
}

export interface CalendarShare {
  id: string;
  calendarOwnerId: string;
  sharedWithUserId: string;
  sharedWithName: string;
  permission: 'view' | 'edit';
  createdAt: string;
}

export interface CalendarFilter {
  from: string;
  to: string;
  types?: CalendarEventType[];
  includeShared?: boolean;
}
