// ============================================================
// Google Calendar integration (Phase 4) — two-way sync
// ============================================================

export interface GoogleConnectionStatus {
  connected: boolean;
  email: string | null;
  /** id of the Google calendar we two-way sync with (events). */
  syncCalendarId: string | null;
  syncCalendarName: string | null;
  /** id of the one-way Google calendar for exported task deadlines. */
  tasksCalendarId: string | null;
  lastSyncedAt: string | null;
}

export interface GoogleCalendarListItem {
  id: string;
  summary: string;
  primary: boolean;
  /** access role; we can only two-way sync calendars we own/write. */
  accessRole: string;
}

/** Pick which Google calendar to two-way sync with. `__new__` = create a dedicated "SuperApp6" calendar. */
export interface SelectGoogleCalendarRequest {
  calendarId: string;
}

export interface GoogleSyncResult {
  pushed: number;
  pulled: number;
  deleted: number;
}
