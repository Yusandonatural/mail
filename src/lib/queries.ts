import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./db";
import { dateCandidates, drafts, messages, type MessageRow, type User } from "./db/schema";

import { visibleFolders } from "./access";
import type { Folder } from "./domain";

export interface FolderCount {
  reply: number;
  unread: number;
  review: number;
}

export async function folderCounts(db: Db, user: User): Promise<Map<string, FolderCount>> {
  const res = await db.execute(sql`
    select x.f as folder,
      count(*) filter (where m.needs_reply and m.status in ('new', 'draft_ready')) as reply,
      count(*) filter (where m.unread) as unread,
      count(*) filter (where m.needs_review) as review
    from messages m,
      lateral (select m.folder as f union select jsonb_array_elements_text(m.secondary_folders)) x
    where m.user_id = ${user.id} and m.status <> 'skipped'
    group by x.f`);
  const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  return new Map(
    rows.map((r) => [String(r.folder), { reply: Number(r.reply), unread: Number(r.unread), review: Number(r.review) }]),
  );
}

export type ListFilter = "all" | "reply" | "draft" | "review" | "dates";

export const FILTER_LABELS: Record<ListFilter, string> = {
  all: "すべて",
  reply: "要返信",
  draft: "下書きあり",
  review: "要確認",
  dates: "日程あり",
};

export interface ListedMessage extends MessageRow {
  hasDates: boolean;
}

function inFolder(folder: string): SQL {
  return or(eq(messages.folder, folder), sql`${messages.secondaryFolders} @> ${JSON.stringify([folder])}::jsonb`)!;
}

export async function listMessages(
  db: Db,
  user: User,
  opts: { folder: Folder | null; filter: ListFilter; page: number; pageSize?: number },
): Promise<ListedMessage[]> {
  const size = opts.pageSize ?? 50;
  const visible = visibleFolders(user);
  const conds: SQL[] = [eq(messages.userId, user.id), sql`${messages.status} <> 'skipped'`];
  if (opts.folder) conds.push(inFolder(opts.folder));
  else conds.push(or(...visible.map(inFolder))!);
  if (opts.filter === "reply") conds.push(and(eq(messages.needsReply, true), inArray(messages.status, ["new", "draft_ready"]))!);
  if (opts.filter === "draft") conds.push(eq(messages.status, "draft_ready"));
  if (opts.filter === "review") conds.push(eq(messages.needsReview, true));
  // 外側の messages を明示的に参照する（列名だけだとサブクエリ側の列に解決されてしまう）
  const hasDates = sql<boolean>`exists (select 1 from date_candidates d where d.user_id = "messages"."user_id" and d.gmail_message_id = "messages"."gmail_message_id" and d.status in ('candidate', 'tentative'))`;
  if (opts.filter === "dates") conds.push(hasDates);

  // 要返信で緊急度の高いものを先頭に、あとは新しい順
  const hot = sql`case when ${messages.urgency} = 'high' and ${messages.status} in ('new', 'draft_ready') then 0 else 1 end`;
  const rows = await db
    .select({ m: messages, hasDates })
    .from(messages)
    .where(and(...conds))
    .orderBy(hot, desc(messages.receivedAt))
    .limit(size)
    .offset(opts.page * size);
  return rows.map((r) => ({ ...r.m, hasDates: Boolean(r.hasDates) }));
}

export async function threadCandidates(db: Db, userId: number, threadId: string) {
  return db
    .select()
    .from(dateCandidates)
    .where(and(eq(dateCandidates.userId, userId), eq(dateCandidates.gmailThreadId, threadId)))
    .orderBy(dateCandidates.start);
}

export async function threadDrafts(db: Db, userId: number, threadId: string) {
  return db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.gmailThreadId, threadId), eq(drafts.status, "ready")))
    .orderBy(desc(drafts.createdAt), desc(drafts.id));
}
