import { eq } from "drizzle-orm";
import { getDb, type Db } from "./db";
import { users, type User } from "./db/schema";
import { ClaudeClassifier } from "./claude/classifier";
import { ClaudeDraftWriter } from "./claude/drafter";
import { GoogleMailApi } from "./google/gmail";
import { GoogleCalendarApi } from "./google/calendar";
import { clientForRefreshToken } from "./google/oauth";
import type { MailApi } from "./google/mail-api";
import type { CalendarApi } from "./google/calendar-api";
import { processMessage } from "./pipeline";
import { generateDraft } from "./drafts";
import { collectSummaries } from "./contacts";
import { PermanentJobError, type JobHandlers } from "./jobs";
import { orderLookupFromEnv } from "./shopify";
import { notifyUser, pushConfigured, WebPushNotifier, type PushPayload } from "./notify";

const classifier = new ClaudeClassifier();
const drafter = new ClaudeDraftWriter();

export function mailFor(user: User): MailApi {
  if (!user.refreshTokenEnc) throw new PermanentJobError(`${user.email} の Google 連携がありません`);
  return new GoogleMailApi(clientForRefreshToken(user.refreshTokenEnc));
}

export function calendarFor(user: User): CalendarApi {
  if (!user.refreshTokenEnc) throw new PermanentJobError(`${user.email} の Google 連携がありません`);
  return new GoogleCalendarApi(clientForRefreshToken(user.refreshTokenEnc));
}

export function draftDeps(db: Db, user: User) {
  return { db, mail: mailFor(user), drafter, calendar: calendarFor(user), orders: orderLookupFromEnv() };
}

export function pipelineDeps(db: Db, user: User) {
  return { db, mail: mailFor(user), classifier };
}

async function loadUser(db: Db, id: unknown): Promise<User> {
  const user = (await db.select().from(users).where(eq(users.id, Number(id))).limit(1))[0];
  if (!user || !user.active) throw new PermanentJobError(`利用者 ${String(id)} が見つかりません`);
  return user;
}

export function jobHandlers(db: Db): JobHandlers {
  return {
    process_message: async (p) => {
      const user = await loadUser(db, p.userId);
      await processMessage(pipelineDeps(db, user), user, String(p.messageId), { autoDraft: p.backfill !== true });
    },
    generate_draft: async (p) => {
      const user = await loadUser(db, p.userId);
      await generateDraft(draftDeps(db, user), user, String(p.threadId), p.messageId ? String(p.messageId) : null, {
        generatedBy: p.generatedBy === "manual" ? "manual" : "auto",
        instruction: typeof p.instruction === "string" ? p.instruction : null,
      });
    },
    collect_summary_batch: async (p) => collectSummaries(db, p),
    notify: async (p) => {
      if (!pushConfigured()) return;
      await notifyUser(db, new WebPushNotifier(), Number(p.userId), p as unknown as PushPayload);
    },
  };
}

export { getDb };
