import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { dateCandidates, messages } from "@/lib/db/schema";
import { confirmCandidate, createEventFromCandidate, defaultEdits, PAYMENT_REMINDER_MINUTES } from "@/lib/calendar-service";
import type { CalendarApi, NewEvent } from "@/lib/google/calendar-api";
import { makeUser, testDb } from "./helpers/db";

class FakeCalendar implements CalendarApi {
  inserted: Array<{ calendarId: string; event: NewEvent }> = [];
  patched: Array<{ eventId: string; summary?: string }> = [];
  async listCalendars() {
    return [];
  }
  async freeBusy() {
    return [];
  }
  async listEvents() {
    return [];
  }
  async insertEvent(calendarId: string, event: NewEvent) {
    this.inserted.push({ calendarId, event });
    return { id: "ev1", htmlLink: "https://calendar.example/ev1" };
  }
  async patchEvent(_c: string, eventId: string, patch: { summary?: string }) {
    this.patched.push({ eventId, ...patch });
  }
}

async function setup(kind: string, start: string, allDay: boolean) {
  const db = await testDb();
  const user = await makeUser(db);
  await db.insert(messages).values({
    userId: user.id,
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    fromEmail: "guest@t.example",
    fromName: "山田",
    subject: "見学希望",
    folder: "tour",
    category: "tour",
    source: "address",
    summary: "10/3 に茶園見学を希望",
    receivedAt: new Date(),
  });
  const [cand] = await db
    .insert(dateCandidates)
    .values({ userId: user.id, gmailMessageId: "m1", gmailThreadId: "t1", kind, title: "茶園見学", start, allDay })
    .returning();
  return { db, user, cand };
}

describe("カレンダー登録", () => {
  it("来客の候補は仮予定として、元メールへのリンク付きで登録する", async () => {
    const { db, user, cand } = await setup("visit", "2026-10-03T10:00:00+09:00", false);
    const cal = new FakeCalendar();
    const edits = await defaultEdits(db, cand);
    expect(edits.title).toBe("【茶ツアー】茶園見学（山田）");
    await createEventFromCandidate(db, cal, user, cand, edits);
    const { event } = cal.inserted[0];
    expect(event.summary).toBe("仮: 【茶ツアー】茶園見学（山田）");
    expect(event.start).toBe("2026-10-03T10:00:00+09:00");
    expect(event.end).toBe("2026-10-03T11:00:00+09:00");
    expect(event.description).toContain("#all/t1");
    expect(event.attendees).toEqual([]);
    const [row] = await db.select().from(dateCandidates);
    expect(row).toMatchObject({ status: "tentative", calendarEventId: "ev1" });

    await confirmCandidate(db, cal, row);
    expect(cal.patched[0]).toEqual({ eventId: "ev1", summary: "【茶ツアー】茶園見学（山田）" });
    const [after] = await db.select().from(dateCandidates).where(eq(dateCandidates.id, row.id));
    expect(after.status).toBe("confirmed");
  });

  it("支払期日は終日予定で、前日に通知する", async () => {
    const { db, user, cand } = await setup("payment_due", "2026-10-31", true);
    const cal = new FakeCalendar();
    await createEventFromCandidate(db, cal, user, cand, await defaultEdits(db, cand));
    const { event } = cal.inserted[0];
    expect(event).toMatchObject({ allDay: true, start: "2026-10-31", end: "2026-11-01", attendees: [] });
    expect(event.reminderMinutes).toBe(PAYMENT_REMINDER_MINUTES);
    expect(event.summary).toBe("茶園見学");
  });
});
