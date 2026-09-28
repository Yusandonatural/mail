import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { dateCandidates, messages, type DateCandidate, type User } from "./db/schema";
import { CATEGORY_LABELS, isCategory, type DateKind } from "./domain";
import type { CalendarApi, CalendarEvent } from "./google/calendar-api";
import { getSetting } from "./settings";
import { addDays, jstDateString, jstIso, parseDateish, startOfJstDay } from "./time";

export const TENTATIVE_PREFIX = "仮: ";

/** 支払期日（終日予定）の通知：前日 9:00（= 当日 0:00 の 15 時間前） */
export const PAYMENT_REMINDER_MINUTES = 15 * 60;

export function gmailThreadLink(userEmail: string, threadId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(userEmail)}#all/${threadId}`;
}

export interface EventEdits {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  calendarId: string;
  tentative: boolean;
}

/** 候補から登録内容の初期値を作る（タイトル = カテゴリ + 相手名） */
export async function defaultEdits(db: Db, candidate: DateCandidate): Promise<EventEdits> {
  const calendarMap = await getSetting(db, "calendarMap");
  const row = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, candidate.userId), eq(messages.gmailMessageId, candidate.gmailMessageId)))
      .limit(1)
  )[0];
  const who = row?.fromName ?? row?.fromEmail ?? "";
  const cat = row?.category && isCategory(row.category) ? CATEGORY_LABELS[row.category] : "";
  const title =
    candidate.kind === "payment_due" ? candidate.title : [cat && `【${cat}】`, candidate.title, who && `（${who}）`].filter(Boolean).join("");
  return {
    title,
    start: candidate.start,
    end: candidate.end,
    allDay: candidate.allDay,
    calendarId: calendarMap[candidate.kind as DateKind] ?? "primary",
    tentative: candidate.kind !== "payment_due",
  };
}

function endFor(edits: EventEdits, start: Date): string {
  if (edits.allDay) {
    const endDate = edits.end ? parseDateish(edits.end) : null;
    // 終日予定の終了日は「翌日」を渡す
    return jstDateString(addDays(endDate ?? start, 1));
  }
  const end = edits.end ? parseDateish(edits.end) : null;
  return jstIso(end && end > start ? end : new Date(start.getTime() + 60 * 60 * 1000));
}

export async function createEventFromCandidate(
  db: Db,
  calendar: CalendarApi,
  user: User,
  candidate: DateCandidate,
  edits: EventEdits,
): Promise<{ id: string; htmlLink: string | null }> {
  const start = parseDateish(edits.start);
  if (!start) throw new Error("開始日時を読み取れません");
  const row = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), eq(messages.gmailMessageId, candidate.gmailMessageId)))
      .limit(1)
  )[0];
  const description = [
    row?.summary ?? candidate.note,
    candidate.note && candidate.note !== row?.summary ? `メモ: ${candidate.note}` : null,
    `元メール: ${gmailThreadLink(user.email, candidate.gmailThreadId)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const created = await calendar.insertEvent(edits.calendarId, {
    summary: edits.tentative ? `${TENTATIVE_PREFIX}${edits.title}` : edits.title,
    description,
    start: edits.allDay ? jstDateString(start) : jstIso(start),
    end: endFor(edits, start),
    allDay: edits.allDay,
    // 相手を参加者に入れると、相手のカレンダーに内部のメモ付きの予定が見えてしまうため入れない
    attendees: [],
    reminderMinutes: candidate.kind === "payment_due" ? PAYMENT_REMINDER_MINUTES : null,
  });
  await db
    .update(dateCandidates)
    .set({
      calendarId: edits.calendarId,
      calendarEventId: created.id,
      title: edits.title,
      start: edits.start,
      end: edits.end,
      allDay: edits.allDay,
      status: edits.tentative ? "tentative" : "confirmed",
    })
    .where(eq(dateCandidates.id, candidate.id));
  return created;
}

/** 仮予定を確定にする（タイトルの「仮: 」を外す）。自動では行わず、人のクリックで呼ぶ */
export async function confirmCandidate(db: Db, calendar: CalendarApi, candidate: DateCandidate): Promise<void> {
  if (!candidate.calendarId || !candidate.calendarEventId) throw new Error("まだカレンダーに登録されていません");
  await calendar.patchEvent(candidate.calendarId, candidate.calendarEventId, { summary: candidate.title });
  await db.update(dateCandidates).set({ status: "confirmed" }).where(eq(dateCandidates.id, candidate.id));
  await db
    .update(messages)
    .set({ suggestConfirm: false })
    .where(and(eq(messages.userId, candidate.userId), eq(messages.gmailThreadId, candidate.gmailThreadId)));
}

/** 対応するカレンダー全ての、指定日（日本時間）の予定 */
export async function eventsForDays(
  db: Db,
  calendar: CalendarApi,
  from: Date,
  days: number,
): Promise<CalendarEvent[]> {
  const calendarMap = await getSetting(db, "calendarMap");
  const ids = [...new Set(Object.values(calendarMap))];
  const start = startOfJstDay(from);
  const end = addDays(start, days);
  const lists = await Promise.all(ids.map((id) => calendar.listEvents(id, start, end).catch(() => [])));
  return lists.flat().sort((a, b) => a.start.localeCompare(b.start));
}
