import { calendar, type calendar_v3 } from "@googleapis/calendar";
import type { OAuth2Client } from "google-auth-library";
import { TIMEZONE } from "../domain";
import type { CalendarApi, CalendarEvent, NewEvent } from "./calendar-api";

export class GoogleCalendarApi implements CalendarApi {
  private api: calendar_v3.Calendar;

  constructor(auth: OAuth2Client) {
    this.api = calendar({ version: "v3", auth });
  }

  async listCalendars() {
    const res = await this.api.calendarList.list({ minAccessRole: "writer" });
    return (res.data.items ?? []).map((c) => ({
      id: c.id ?? "",
      summary: c.summaryOverride ?? c.summary ?? c.id ?? "",
      primary: Boolean(c.primary),
    }));
  }

  async freeBusy(calendarIds: string[], timeMin: Date, timeMax: Date) {
    const res = await this.api.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: TIMEZONE,
        items: calendarIds.map((id) => ({ id })),
      },
    });
    const busy = Object.values(res.data.calendars ?? {}).flatMap((c) => c.busy ?? []);
    return busy
      .filter((b) => b.start && b.end)
      .map((b) => ({ start: new Date(b.start as string), end: new Date(b.end as string) }));
  }

  async listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
    const res = await this.api.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    return (res.data.items ?? [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        id: e.id ?? "",
        calendarId,
        summary: e.summary ?? "(無題)",
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date ?? "",
        allDay: Boolean(e.start?.date && !e.start?.dateTime),
        description: e.description ?? "",
        htmlLink: e.htmlLink ?? null,
      }));
  }

  async insertEvent(calendarId: string, event: NewEvent) {
    const when = (v: string) => (event.allDay ? { date: v } : { dateTime: v, timeZone: TIMEZONE });
    const res = await this.api.events.insert({
      calendarId,
      // 相手に招待メールは送らない（登録は内部の予定管理のため）
      sendUpdates: "none",
      requestBody: {
        summary: event.summary,
        description: event.description,
        start: when(event.start),
        end: when(event.end),
        attendees: event.attendees.map((email) => ({ email })),
        reminders:
          event.reminderMinutes === null
            ? { useDefault: true }
            : { useDefault: false, overrides: [{ method: "popup", minutes: event.reminderMinutes }] },
      },
    });
    return { id: res.data.id ?? "", htmlLink: res.data.htmlLink ?? null };
  }

  async patchEvent(calendarId: string, eventId: string, patch: { summary?: string }) {
    await this.api.events.patch({ calendarId, eventId, sendUpdates: "none", requestBody: patch });
  }
}
