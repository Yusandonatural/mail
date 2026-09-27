import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db";
import { contacts, messages, users, type User } from "./db/schema";
import type { MailApi } from "./google/mail-api";
import { parseMessage, stripQuoted } from "./mail/parse";
import { collectSummaryBatch, submitSummaryBatch, type SummaryItem } from "./claude/summarizer";
import { enqueue, RetryLaterError } from "./jobs";
import { sha256 } from "./crypto";
import { formatJst } from "./time";

const MAX_CONTACTS_PER_NIGHT = 100;

/**
 * 夜間：前回の要約以降にやりとりがあった相手について、直近のメールから関係の要約を作る。
 * Message Batches（半額）で投げ、回収は collect_summary_batch ジョブで行う（仕様書 5章）。
 */
export async function startNightlySummaries(
  db: Db,
  mailForUser: (user: User) => MailApi,
  now = new Date(),
): Promise<string | null> {
  const due = await db
    .select()
    .from(contacts)
    .where(or(isNull(contacts.summarizedAt), gt(contacts.lastMessageAt, contacts.summarizedAt)))
    .limit(MAX_CONTACTS_PER_NIGHT);
  const items: SummaryItem[] = [];
  const map: Record<string, string> = {};
  for (const c of due) {
    // その相手のメールを持っている利用者の受信箱から読む
    const owner = (
      await db
        .select({ user: users })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.userId))
        .where(and(eq(messages.fromEmail, c.email), eq(users.active, true)))
        .orderBy(sql`${messages.receivedAt} desc`)
        .limit(1)
    )[0]?.user;
    if (!owner?.refreshTokenEnc) continue;
    const mail = mailForUser(owner);
    const ids = await mail.listMessageIds(`from:${c.email} OR to:${c.email}`, 10).catch(() => []);
    if (!ids.length) continue;
    const excerpts: string[] = [];
    for (const id of ids.reverse()) {
      const m = parseMessage(await mail.getMessage(id));
      excerpts.push(
        `[${formatJst(m.date)}] ${m.from?.email ?? ""} 件名: ${m.subject}\n${(stripQuoted(m.text) || m.text).slice(0, 1500)}`,
      );
    }
    const customId = `c${sha256(c.email).slice(0, 40)}`;
    map[customId] = c.email;
    items.push({ customId, email: c.email, excerpts: excerpts.join("\n\n") });
  }
  if (!items.length) return null;
  const batchId = await submitSummaryBatch(items);
  await enqueue(
    db,
    "collect_summary_batch",
    { batchId, map, startedAt: now.toISOString() },
    `batch:${batchId}`,
    new Date(now.getTime() + 30 * 60 * 1000),
  );
  return batchId;
}

export async function collectSummaries(db: Db, payload: Record<string, unknown>): Promise<void> {
  const batchId = String(payload.batchId);
  const map = payload.map as Record<string, string>;
  const state = await collectSummaryBatch(batchId);
  if (!state.done) throw new RetryLaterError(30 * 60 * 1000);
  const at = new Date(String(payload.startedAt ?? new Date().toISOString()));
  for (const [customId, text] of state.results) {
    const email = map[customId];
    if (!email) continue;
    await db
      .update(contacts)
      .set({ lastSummary: text, summarizedAt: at, updatedAt: new Date() })
      .where(eq(contacts.email, email));
  }
}
