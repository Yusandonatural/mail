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
  freeeSent: boolean;
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
  // 「受信箱（全て）」にはニュースレターを出さない（受信の約8割を占めるため）
  else conds.push(or(...visible.filter((f) => f !== "info").map(inFolder))!, sql`${messages.folder} <> 'info'`);
  if (opts.filter === "reply") conds.push(and(eq(messages.needsReply, true), inArray(messages.status, ["new", "draft_ready"]))!);
  if (opts.filter === "draft") conds.push(eq(messages.status, "draft_ready"));
  if (opts.filter === "review") conds.push(eq(messages.needsReview, true));
  // 外側の messages を明示的に参照する（列名だけだとサブクエリ側の列に解決されてしまう）
  const hasDates = sql<boolean>`exists (select 1 from date_candidates d where d.user_id = "messages"."user_id" and d.gmail_message_id = "messages"."gmail_message_id" and d.status in ('candidate', 'tentative'))`;
  if (opts.filter === "dates") conds.push(hasDates);
  const freeeSent = sql<boolean>`exists (select 1 from freee_uploads f where f.gmail_message_id = "messages"."gmail_message_id" or (f.rfc_message_id is not null and f.rfc_message_id = "messages"."rfc_message_id"))`;

  // 新しく届いた順（至急のものは左端の赤い帯で見分ける）
  const rows = await db
    .select({ m: messages, hasDates, freeeSent })
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(size + 1)
    .offset(opts.page * size);
  return rows.map((r) => ({ ...r.m, hasDates: Boolean(r.hasDates), freeeSent: Boolean(r.freeeSent) }));
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

/** 要返信の件数（副ラベルで複数のフォルダに出るメールも1通として数える） */
export async function totalReplyCount(db: Db, user: User): Promise<number> {
  const visible = visibleFolders(user).filter((f) => f !== "info");
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.userId, user.id),
        eq(messages.needsReply, true),
        inArray(messages.status, ["new", "draft_ready"]),
        or(...visible.map(inFolder))!,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** 一覧からメールを開いたときの「戻る」先。自分のアプリ内の一覧だけを許す */
export function safeBack(value: string | undefined | null): string {
  if (value && /^\/(inbox|search|today)(\?|$)/.test(value)) return value;
  return "/inbox";
}
