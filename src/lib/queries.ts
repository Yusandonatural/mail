import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./db";
import { dateCandidates, drafts, messages, type MessageRow, type User } from "./db/schema";

import { canSeeMessage, visibleFolders } from "./access";
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
    where m.user_id = ${user.id} and m.status not in ('skipped', 'archived')
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
  draft: "下書き",
  review: "要確認",
  dates: "日程あり",
};

function inFolder(folder: string): SQL {
  return or(eq(messages.folder, folder), sql`${messages.secondaryFolders} @> ${JSON.stringify([folder])}::jsonb`)!;
}

export interface ListedMessage extends MessageRow {
  hasDates: boolean;
  freeeSent: boolean;
  /** 同じスレッドで一覧の条件に合うメールの数（2以上なら「やり取り」） */
  threadCount: number;
  /** スレッドの中に未読があるか */
  threadUnread: boolean;
  /** スレッドの中に、まだ返信していない「要返信」のメールがあるか（行に出す最新のメールに限らない） */
  threadOpen: boolean;
  /** そのうち至急のものがあるか */
  threadUrgent: boolean;
  /** スレッドの中に下書きのあるメールがあるか */
  threadDraft: boolean;
}

/** 一覧の共通条件（受信箱はニュースレター以外の全フォルダ） */
function listConds(user: User, folder: Folder | null, filter: ListFilter): SQL[] {
  const visible = visibleFolders(user);
  // アーカイブ・迷惑メール・ゴミ箱にしたメールは一覧に出さない
  const conds: SQL[] = [eq(messages.userId, user.id), sql`${messages.status} not in ('skipped', 'archived')`];
  if (folder) conds.push(inFolder(folder));
  else conds.push(or(...visible.filter((f) => f !== "info").map(inFolder))!, sql`${messages.folder} <> 'info'`);
  if (filter === "reply") conds.push(and(eq(messages.needsReply, true), inArray(messages.status, ["new", "draft_ready"]))!);
  if (filter === "draft") conds.push(eq(messages.status, "draft_ready"));
  if (filter === "review") conds.push(eq(messages.needsReview, true));
  if (filter === "dates") conds.push(hasDatesSql);
  return conds;
}

// 外側の messages を明示的に参照する（列名だけだとサブクエリ側の列に解決されてしまう）
const hasDatesSql = sql<boolean>`exists (select 1 from date_candidates d where d.user_id = "messages"."user_id" and d.gmail_message_id = "messages"."gmail_message_id" and d.status in ('candidate', 'tentative'))`;
const openSql = sql`(${messages.needsReply} and ${messages.status} in ('new', 'draft_ready'))`;
const freeeSentSql = sql<boolean>`exists (select 1 from freee_uploads f where f.gmail_message_id = "messages"."gmail_message_id" or (f.rfc_message_id is not null and f.rfc_message_id = "messages"."rfc_message_id"))`;

/**
 * 一覧。スレッドごとに1行にまとめ、最後にメールが届いた順（新しいものが上）に並べる。
 * 行に出すのはスレッドの最新のメール。
 */
export async function listMessages(
  db: Db,
  user: User,
  opts: { folder: Folder | null; filter: ListFilter; page: number; pageSize?: number },
): Promise<ListedMessage[]> {
  const size = opts.pageSize ?? 50;
  const conds = listConds(user, opts.folder, opts.filter);
  const ranked = db
    .select({
      rid: sql<number>`${messages.id}`.as("rid"),
      rn: sql<number>`row_number() over (partition by ${messages.gmailThreadId} order by ${messages.receivedAt} desc, ${messages.id} desc)`.as("rn"),
      n: sql<number>`count(*) over (partition by ${messages.gmailThreadId})`.as("n"),
      anyUnread: sql<boolean>`bool_or(${messages.unread}) over (partition by ${messages.gmailThreadId})`.as("any_unread"),
      anyOpen: sql<boolean>`bool_or(${openSql}) over (partition by ${messages.gmailThreadId})`.as("any_open"),
      anyUrgent: sql<boolean>`bool_or(${openSql} and ${messages.urgency} = 'high') over (partition by ${messages.gmailThreadId})`.as("any_urgent"),
      anyDraft: sql<boolean>`bool_or(${messages.status} = 'draft_ready') over (partition by ${messages.gmailThreadId})`.as("any_draft"),
    })
    .from(messages)
    .where(and(...conds))
    .as("ranked");
  const rows = await db
    .select({
      m: messages,
      hasDates: hasDatesSql,
      freeeSent: freeeSentSql,
      n: ranked.n,
      anyUnread: ranked.anyUnread,
      anyOpen: ranked.anyOpen,
      anyUrgent: ranked.anyUrgent,
      anyDraft: ranked.anyDraft,
    })
    .from(messages)
    .innerJoin(ranked, sql`${ranked.rid} = ${messages.id}`)
    .where(sql`${ranked.rn} = 1`)
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(size + 1)
    .offset(opts.page * size);
  return rows.map((r) => ({
    ...r.m,
    hasDates: Boolean(r.hasDates),
    freeeSent: Boolean(r.freeeSent),
    threadCount: Number(r.n),
    threadUnread: Boolean(r.anyUnread),
    threadOpen: Boolean(r.anyOpen),
    threadUrgent: Boolean(r.anyUrgent),
    threadDraft: Boolean(r.anyDraft),
  }));
}

/**
 * 一覧はスレッドで1行なので、行に対する操作（迷惑メール・削除・アーカイブ）はスレッドの全メールに広げる。
 * 最新の1通だけを外すと、同じスレッドの古いメールが一覧に出直してしまうため。見られないフォルダのメールは含めない。
 */
export async function threadRowsOf(db: Db, user: User, rows: MessageRow[]): Promise<MessageRow[]> {
  const threadIds = [...new Set(rows.map((r) => r.gmailThreadId))];
  if (!threadIds.length) return [];
  const all = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, user.id), inArray(messages.gmailThreadId, threadIds), sql`${messages.status} <> 'skipped'`));
  return all.filter((r) => canSeeMessage(user, r));
}

/** 絞り込みタブに出す件数（スレッド数） */
export async function filterCounts(db: Db, user: User, folder: Folder | null): Promise<Record<"reply" | "draft" | "review", number>> {
  const count = async (filter: ListFilter) => {
    const res = await db
      .select({ n: sql<number>`count(distinct ${messages.gmailThreadId})` })
      .from(messages)
      .where(and(...listConds(user, folder, filter)));
    return Number(res[0]?.n ?? 0);
  };
  const [reply, draft, review] = await Promise.all([count("reply"), count("draft"), count("review")]);
  return { reply, draft, review };
}

/** 未読のニュースレター・お知らせの数（受信箱の上にまとめて出す） */
export async function unreadNewsletterCount(db: Db, user: User): Promise<number> {
  if (!visibleFolders(user).includes("info")) return 0;
  const res = await db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.userId, user.id), eq(messages.folder, "info"), eq(messages.unread, true), sql`${messages.status} not in ('skipped', 'archived')`));
  return Number(res[0]?.n ?? 0);
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

/** 受信箱の要返信の件数（ニュースレター以外。副ラベルで複数のフォルダに出るメールも1通として数える） */
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
        sql`${messages.folder} <> 'info'`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** 一覧からメールを開いたときの「戻る」先。自分のアプリ内の一覧だけを許す */
export function safeBack(value: string | undefined | null): string {
  if (value && /^\/(inbox|search|today)(\?|$)/.test(value)) return value;
  return "/inbox";
}
