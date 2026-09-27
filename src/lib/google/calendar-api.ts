export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  description: string;
  htmlLink: string | null;
}

export interface NewEvent {
  summary: string;
  description: string;
  /** allDay のときは YYYY-MM-DD、それ以外は ISO 8601 */
  start: string;
  end: string;
  allDay: boolean;
  attendees: string[];
  /** 開始の何分前に通知するか（null なら既定） */
  reminderMinutes: number | null;
}

export interface CalendarApi {
  listCalendars(): Promise<CalendarInfo[]>;
  freeBusy(calendarIds: string[], timeMin: Date, timeMax: Date): Promise<Interval[]>;
  listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
  insertEvent(calendarId: string, event: NewEvent): Promise<{ id: string; htmlLink: string | null }>;
  patchEvent(calendarId: string, eventId: string, patch: { summary?: string }): Promise<void>;
}
