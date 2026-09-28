"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { dateCandidates } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { confirmCandidate, createEventFromCandidate } from "@/lib/calendar-service";
import { calendarFor } from "@/lib/services";
import { requireUser } from "@/lib/session";

async function ownCandidate(id: number) {
  const user = await requireUser();
  const db = await getDb();
  const c = (
    await db
      .select()
      .from(dateCandidates)
      .where(and(eq(dateCandidates.id, id), eq(dateCandidates.userId, user.id)))
      .limit(1)
  )[0];
  if (!c) throw new Error("日程候補が見つかりません");
  return { user, db, c };
}

export async function createEventAction(formData: FormData): Promise<void> {
  const { user, db, c } = await ownCandidate(Number(formData.get("candidateId")));
  const allDay = formData.get("allDay") === "on";
  let start = String(formData.get("start") ?? "");
  let end = String(formData.get("end") ?? "");
  // 終日の候補で「終日」を外したときは日付しか無いので、朝 10 時からの 1 時間にする
  if (!allDay && /^\d{4}-\d{2}-\d{2}$/.test(start)) start = `${start}T10:00`;
  if (!allDay && /^\d{4}-\d{2}-\d{2}$/.test(end)) end = "";
  const created = await createEventFromCandidate(db, calendarFor(user), user, c, {
    title: String(formData.get("title") ?? c.title),
    start: allDay ? start.slice(0, 10) : start,
    end: end ? (allDay ? end.slice(0, 10) : end) : null,
    allDay,
    calendarId: String(formData.get("calendarId") ?? "primary"),
    tentative: formData.get("tentative") === "on",
  });
  await audit(db, user.id, "event_created", c.gmailThreadId, { eventId: created.id });
  revalidatePath(String(formData.get("back") ?? "/inbox").split("?")[0]);
}

export async function confirmEventAction(formData: FormData): Promise<void> {
  const { user, db, c } = await ownCandidate(Number(formData.get("candidateId")));
  await confirmCandidate(db, calendarFor(user), c);
  await audit(db, user.id, "event_confirmed", c.gmailThreadId, { eventId: c.calendarEventId });
  revalidatePath(String(formData.get("back") ?? "/inbox").split("?")[0]);
}

export async function ignoreCandidateAction(formData: FormData): Promise<void> {
  const { db, c } = await ownCandidate(Number(formData.get("candidateId")));
  await db.update(dateCandidates).set({ status: "ignored" }).where(eq(dateCandidates.id, c.id));
  revalidatePath(String(formData.get("back") ?? "/inbox").split("?")[0]);
}
