import { and, desc, eq, gte, inArray, isNotNull, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "./db";
import { dateCandidates, drafts, messages, rules, type MessageRow, type User } from "./db/schema";

import { canSeeFolder, canSeeMessage, isAdmin, visibleFolders } from "./access";
import type { Folder } from "./domain";

export interface FolderCount {
  reply: number;
  unread: number;
  review: number;
}

/** 左のフォルダの件数。一覧（スレッドごとに1行）・絞り込みタブと合わせてスレッドの数を数える */
export async function folderCounts(db: Db, user: User): Promise<Map<string, FolderCount>> {
  const res = await db.execute(sql`
    select x.f as folder,
      count(distinct m.gmail_thread_id) filter (where m.needs_reply and m.status in ('new', 'draft_ready')) as reply,
      count(distinct m.gmail_thread_id) filter (where m.unread) as unread,
      count(distinct m.gmail_thread_id) filter (where m.needs_review) as review
    from messages m,
      lateral (select m.folder as f union select jsonb_array_elements_text(m.secondary_folders)) x
    where m.user_id = ${user.id} and m.status not in ('skipped', 'archived')
      -- 数える対象（要返信・未読・要確認）の行だけを読む（部分索引 messages_counted を使う）。件数が全て0のフォルダは返さない
      and (m.unread or m.needs_review or (m.needs_reply and m.status in ('new', 'draft_ready')))
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

/** messages 表か、その別名（同じスレッドの他のメールを見るサブクエリ用） */
type MessagesTable = typeof messages;

function inFolder(folder: string, t: MessagesTable = messages): SQL {
  return or(eq(t.folder, folder), sql`${t.secondaryFolders} @> ${JSON.stringify([folder])}::jsonb`)!;
}

/**
 * どれかのフォルダに入っているメール。見られるフォルダが1つも無いときは何も出さない
 * （or() は条件が空だと undefined を返し、and() がそれを無視して全件になってしまうため）。
 * フォルダごとに OR でつなぐと行ごとの判定が重く、実行計画の見積もりも狂うので、配列でまとめて比べる
 */
function anyFolder(folders: string[], t: MessagesTable = messages): SQL {
  if (!folders.length) return sql`false`;
  const list = sql.join(
    folders.map((f) => sql`${f}`),
    sql`, `,
  );
  return sql`(${inArray(t.folder, folders)} or ${t.secondaryFolders} ?| array[${list}]::text[])`;
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

/** 一覧の共通条件（受信箱はニュースレター以外の全フォルダ）。t に別名を渡せば、その表の列で組み立てる */
function listConds(user: User, folder: Folder | null, filter: ListFilter, t: MessagesTable = messages): SQL[] {
  const visible = visibleFolders(user);
  // アーカイブ・迷惑メール・ゴミ箱にしたメールは一覧に出さない
  const conds: SQL[] = [eq(t.userId, user.id), sql`${t.status} not in ('skipped', 'archived')`];
  if (folder) conds.push(inFolder(folder, t));
  else conds.push(anyFolder(visible.filter((f) => f !== "info"), t), sql`${t.folder} <> 'info'`);
  if (filter === "reply") conds.push(and(eq(t.needsReply, true), inArray(t.status, ["new", "draft_ready"]))!);
  if (filter === "draft") conds.push(eq(t.status, "draft_ready"));
  if (filter === "review") conds.push(eq(t.needsReview, true));
  if (filter === "dates") conds.push(hasDatesSql(t));
  return conds;
}

// 外側の messages（または別名）を表名付きで参照する（列名だけだとサブクエリ側の列に解決されてしまう）。
// 列オブジェクトは WHERE と結合のある SELECT では表名付きで出力される
const hasDatesSql = (t: MessagesTable = messages) =>
  sql<boolean>`exists (select 1 from date_candidates d where d.user_id = ${t.userId} and d.gmail_message_id = ${t.gmailMessageId} and d.status in ('candidate', 'tentative'))`;
const openSql = (t: MessagesTable) => sql`(${t.needsReply} and ${t.status} in ('new', 'draft_ready'))`;
const freeeSentSql = sql<boolean>`exists (select 1 from freee_uploads f where f.gmail_message_id = "messages"."gmail_message_id" or (f.rfc_message_id is not null and f.rfc_message_id = "messages"."rfc_message_id"))`;

/**
 * 一覧。スレッドごとに1行にまとめ、最後にメールが届いた順（新しいものが上）に並べる。
 * 行に出すのはスレッドの最新のメール。
 * 全件にウィンドウ関数をかけるとメールが増えるほど遅くなるので、届いた順の索引を新しい方からたどり、
 * 「同じスレッドに条件に合うもっと新しいメールが無い」ものだけをページの分だけ拾う。
 * スレッドの件数などは、拾った行のスレッドについてだけ数える。
 */
export async function listMessages(
  db: Db,
  user: User,
  opts: { folder: Folder | null; filter: ListFilter; page: number; pageSize?: number },
): Promise<ListedMessage[]> {
  const size = opts.pageSize ?? 50;
  const conds = (t: MessagesTable = messages) => listConds(user, opts.folder, opts.filter, t);
  const newer = alias(messages, "newer") as unknown as MessagesTable;
  const page = db
    .select({ pid: sql<number>`${messages.id}`.as("pid") })
    .from(messages)
    .where(
      and(
        ...conds(),
        notExists(
          db
            .select({ one: sql`1` })
            .from(newer)
            .where(
              and(
                eq(newer.gmailThreadId, messages.gmailThreadId),
                sql`(${newer.receivedAt}, ${newer.id}) > (${messages.receivedAt}, ${messages.id})`,
                ...conds(newer),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(size + 1)
    .offset(opts.page * size)
    .as("page");
  const t = alias(messages, "th") as unknown as MessagesTable;
  const thread = db
    .select({
      n: sql<number>`count(*)`.as("n"),
      anyUnread: sql<boolean>`bool_or(${t.unread})`.as("any_unread"),
      anyOpen: sql<boolean>`bool_or(${openSql(t)})`.as("any_open"),
      anyUrgent: sql<boolean>`bool_or(${openSql(t)} and ${t.urgency} = 'high')`.as("any_urgent"),
      anyDraft: sql<boolean>`bool_or(${t.status} = 'draft_ready')`.as("any_draft"),
    })
    .from(t)
    .where(and(eq(t.gmailThreadId, messages.gmailThreadId), ...conds(t)))
    .as("thread");
  const rows = await db
    .select({
      m: messages,
      hasDates: hasDatesSql(),
      freeeSent: freeeSentSql,
      n: thread.n,
      anyUnread: thread.anyUnread,
      anyOpen: thread.anyOpen,
      anyUrgent: thread.anyUrgent,
      anyDraft: thread.anyDraft,
    })
    .from(messages)
    .innerJoin(page, sql`${page.pid} = ${messages.id}`)
    .crossJoinLateral(thread)
    .orderBy(desc(messages.receivedAt), desc(messages.id));
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
 * スレッドの中で、その人が見られないフォルダに分類されたメールの Gmail ID。
 * メール画面はスレッド全体を Gmail から読むので、同じスレッドに後から届いた経理のメールなどを出さないために使う。
 */
export async function hiddenInThread(db: Db, user: User, threadId: string): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, user.id), eq(messages.gmailThreadId, threadId)));
  return new Set(rows.filter((r) => !canSeeMessage(user, r)).map((r) => r.gmailMessageId));
}

/**
 * 一覧の操作から学習ルール（送信者・ドメイン → フォルダ／迷惑メール）を書いてよいパターン。
 * ルールは全員の受信箱に効くので、担当者は「ルールが無い」か「自分が見られるフォルダへのルール」だけ書き換えられる。
 * 見られないフォルダ（経理など）や迷惑メールへのルールを書き換えると、ほかの人のメールの行き先を変えたり、
 * 見られないはずのメールを自分のフォルダへ流し込めたりするため。管理者は全て書ける。
 */
export async function overwritableRules(db: Db, user: User, kind: string, patterns: string[]): Promise<Set<string>> {
  if (isAdmin(user) || !patterns.length) return new Set(patterns);
  const existing = await db
    .select()
    .from(rules)
    .where(and(eq(rules.kind, kind), inArray(rules.pattern, patterns)));
  const locked = new Set(existing.filter((r) => !canSeeFolder(user, r.folder)).map((r) => r.pattern));
  return new Set(patterns.filter((p) => !locked.has(p)));
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

/**
 * 受信箱の要返信の件数（ニュースレター以外）。一覧と同じくスレッドの数を数える
 * （副ラベルで複数のフォルダに出るメールも、同じスレッドの複数のメールも1件）
 */
export async function totalReplyCount(db: Db, user: User): Promise<number> {
  const visible = visibleFolders(user).filter((f) => f !== "info");
  const rows = await db
    .select({ n: sql<number>`count(distinct ${messages.gmailThreadId})` })
    .from(messages)
    .where(
      and(
        eq(messages.userId, user.id),
        eq(messages.needsReply, true),
        inArray(messages.status, ["new", "draft_ready"]),
        anyFolder(visible),
        sql`${messages.folder} <> 'info'`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** 近い支払期日（今日・今週の予定に出す）。アーカイブ・迷惑メール・ゴミ箱にしたメールは出さない */
export async function upcomingDues(db: Db, user: User, from: string, to: string): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, user.id),
        isNotNull(messages.dueDate),
        gte(messages.dueDate, from),
        lte(messages.dueDate, to),
        sql`${messages.status} not in ('skipped', 'archived')`,
      ),
    )
    .orderBy(messages.dueDate);
  return rows.filter((m) => canSeeMessage(user, m));
}

/** 一覧からメールを開いたときの「戻る」先。自分のアプリ内の一覧だけを許す */
export function safeBack(value: string | undefined | null): string {
  if (value && /^\/(inbox|search|today)(\?|$)/.test(value)) return value;
  return "/inbox";
}
