import { and, eq, inArray, isNull, max, ne, notInArray } from "drizzle-orm";
import type { Db } from "./db";
import { dateCandidates, messages, users, type User } from "./db/schema";
import { folderLabelName, isFolder, STATUS_LABELS } from "./domain";
import { HistoryExpiredError, type HistoryChanges, type MailApi } from "./google/mail-api";
import { markRepliedLabels } from "./pipeline";
import { enqueue } from "./jobs";

/** Gmail の watch は 7 日で切れるので、毎日（20時間以上経っていれば）更新する */
const WATCH_RENEW_MS = 20 * 60 * 60 * 1000;

export async function ensureWatch(db: Db, mail: MailApi, user: User, topic: string, now = new Date()): Promise<boolean> {
  if (!topic) return false;
  const fresh =
    user.watchRenewedAt &&
    now.getTime() - user.watchRenewedAt.getTime() < WATCH_RENEW_MS &&
    user.watchExpiresAt &&
    user.watchExpiresAt.getTime() > now.getTime();
  if (fresh) return false;
  const res = await mail.watch(topic);
  await db
    .update(users)
    .set({
      watchExpiresAt: res.expiration,
      watchRenewedAt: now,
      historyId: user.historyId ?? res.historyId,
    })
    .where(eq(users.id, user.id));
  return true;
}

async function enqueueMessages(db: Db, user: User, ids: string[], backfilled = false): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const payload = { userId: user.id, messageId: id, ...(backfilled ? { backfill: true } : {}) };
    if (await enqueue(db, "process_message", payload, `msg:${user.id}:${id}`)) n++;
  }
  return n;
}

/**
 * 前回の履歴 ID 以降に届いたメールを処理キューに積む。
 * push 通知の取りこぼしに備え、cron からも 5 分ごとに呼ぶ（仕様書 4章）。
 */
export async function syncUser(db: Db, mail: MailApi, user: User): Promise<number> {
  if (!user.historyId) {
    const profile = await mail.getProfile();
    await db.update(users).set({ historyId: profile.historyId }).where(eq(users.id, user.id));
    return 0;
  }
  let startHistoryId = user.historyId;
  try {
    // push と cron が同じ人を同時に同期することがある。履歴 ID を読み直して、先に進んだ方から続きを読む
    for (let round = 0; round < 3; round++) {
      const changes = await mail.listHistory(startHistoryId);
      const result = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        // 同時に走った同期が先に履歴を進めていれば、ここで読んだ変更（古い範囲）は反映しない。
        // 反映すると、後から来た古い変更で新しい状態（受信トレイに戻した・既読にした など）を上書きし、
        // 履歴 ID も巻き戻ってしまう。ロックは同期が終わるまで持つ（もう一方は終わるのを待ってから読み直す）
        const [current] = await tx
          .select({ historyId: users.historyId })
          .from(users)
          .where(eq(users.id, user.id))
          .for("update");
        if (current?.historyId !== startHistoryId) return { movedTo: current?.historyId ?? null };
        const { messageIds, readIds, restoredIds = [], historyId } = changes;
        let n = await enqueueMessages(tx, user, messageIds);
        // Gmail の迷惑メールなどから人が戻したメール。届いたときのジョブは「飛ばした」で終わっているので別のキーで積む
        // （既に一覧にあるメールは processMessage が二重に作らない）
        const added = new Set(messageIds);
        for (const id of restoredIds) {
          if (added.has(id)) continue;
          if (await enqueue(tx, "process_message", { userId: user.id, messageId: id }, `restore:${user.id}:${id}:${historyId}`)) n++;
        }
        if (readIds.length) {
          await tx
            .update(messages)
            .set({ unread: false })
            .where(and(eq(messages.userId, user.id), inArray(messages.gmailMessageId, readIds)));
        }
        await applyGmailChanges(tx, mail, user, changes);
        await tx.update(users).set({ historyId }).where(eq(users.id, user.id));
        return { queued: n };
      });
      if (result.queued !== undefined) return result.queued;
      if (!result.movedTo) return 0;
      startHistoryId = result.movedTo;
    }
    return 0;
  } catch (err) {
    if (!(err instanceof HistoryExpiredError)) throw err;
    // 履歴が古すぎる：直近2日分を拾い直す（処理済みは重複キーで弾かれる）
    const ids = await mail.listMessageIds("newer_than:2d -in:drafts", 500);
    let n = await enqueueMessages(db, user, ids);
    // 履歴が切れるのは長く同期できなかった後（ログインの期限切れなど）。最後に取り込んだメール以降を
    // 過去メールの取り込みとして拾い直す（2日より前の分を取りこぼさない。下書き・通知は出さない）
    const gap = await daysSinceLastMessage(db, user);
    if (gap > 2) {
      const recent = new Set(ids);
      const older = await mail.listMessageIds(`newer_than:${gap}d -in:drafts`, BACKFILL_MAX);
      n += await enqueueMessages(db, user, older.filter((id) => !recent.has(id)), true);
    }
    const profile = await mail.getProfile();
    await db.update(users).set({ historyId: profile.historyId }).where(eq(users.id, user.id));
    return n;
  }
}

/**
 * 人が Gmail（ウェブ・スマホ）で直接行った操作を一覧に反映する。
 * アプリ自身のアーカイブ・迷惑メール・ゴミ箱も同じ履歴で届くが、その行は既に archived / skipped なので何も変わらない。
 */
async function applyGmailChanges(db: Db, mail: MailApi, user: User, changes: HistoryChanges): Promise<void> {
  const { unreadIds = [], archivedIds = [], inboxIds = [], trashedIds = [], deletedIds = [] } = changes;
  const mine = (ids: string[]) => and(eq(messages.userId, user.id), inArray(messages.gmailMessageId, ids));
  if (unreadIds.length) await db.update(messages).set({ unread: true }).where(mine(unreadIds));

  // ゴミ箱・迷惑メールへ移された、完全に削除された：アプリの迷惑メール・ゴミ箱と同じく一覧から外す。
  // ゴミ箱・迷惑メールから戻されたら restoredIds で処理し直す
  const gone = [...new Set([...trashedIds, ...deletedIds])];
  if (gone.length) {
    await db
      .update(messages)
      .set({ status: "skipped", needsReply: false, unread: false })
      .where(and(mine(gone), ne(messages.status, "skipped")));
  }

  // アーカイブされた（受信トレイから外された）。受信トレイに無かったメール（フィルタで受信トレイを
  // スキップしたものなど）は INBOX が外れる履歴が無いので含まれない
  if (archivedIds.length) {
    const archive = { status: "archived", needsReply: false };
    // 要返信・下書きありだった行は、アプリのアーカイブと同じく Gmail の「要返信」「下書きあり」も外して対応済にする
    // （失敗しても一覧はアーカイブにする。ラベルは次に人が触るまで残る）
    const open = await db
      .update(messages)
      .set(archive)
      .where(and(mine(archivedIds), inArray(messages.status, ["new", "draft_ready"])))
      .returning({ gmailMessageId: messages.gmailMessageId });
    await db
      .update(messages)
      .set(archive)
      .where(and(mine(archivedIds), notInArray(messages.status, ["archived", "skipped"])));
    await markRepliedLabels(
      mail,
      open.map((r) => r.gmailMessageId),
    ).catch((err) => console.error("label archived messages failed", user.id, err));
  }

  // 受信トレイに戻された：アーカイブした行を一覧に戻す。要返信はアーカイブで外れているので戻さず、
  // このメールより後に自分たちの返信がスレッドにあれば返信済、無ければ対応済にする
  if (inboxIds.length) {
    const rows = await db
      .select({ id: messages.id, threadId: messages.gmailThreadId, receivedAt: messages.receivedAt })
      .from(messages)
      .where(and(mine(inboxIds), eq(messages.status, "archived")));
    const sentAt = new Map<string, number[]>();
    for (const threadId of new Set(rows.map((r) => r.threadId))) {
      const thread = await mail.getThread(threadId).catch((err) => {
        console.error("thread lookup failed", threadId, err);
        return null;
      });
      sentAt.set(
        threadId,
        (thread?.messages ?? []).filter((m) => m.labelIds?.includes("SENT")).map((m) => Number(m.internalDate ?? 0)),
      );
    }
    const replied = rows
      .filter((r) => sentAt.get(r.threadId)!.some((t) => t >= r.receivedAt.getTime()))
      .map((r) => r.id);
    const done = rows.map((r) => r.id).filter((id) => !replied.includes(id));
    for (const [status, ids] of [["replied", replied], ["done", done]] as const) {
      if (!ids.length) continue;
      await db
        .update(messages)
        .set({ status, needsReply: false })
        .where(and(inArray(messages.id, ids), eq(messages.status, "archived")));
    }
  }
}

/** 最後に取り込んだメールから今日までの日数（1日の余裕を足し、最大 30 日）。メールが無ければ 0 */
async function daysSinceLastMessage(db: Db, user: User, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ at: max(messages.receivedAt) })
    .from(messages)
    .where(eq(messages.userId, user.id));
  if (!row?.at) return 0;
  const days = Math.ceil((now.getTime() - new Date(row.at).getTime()) / 86_400_000) + 1;
  return Math.min(30, Math.max(0, days));
}

/** 取り込みの上限。受信トレイの 90 日分（約 1 万通）が収まる大きさ */
export const BACKFILL_MAX = 15000;

/** 過去のメールをさかのぼって分類する（管理画面から実行） */
export async function backfill(db: Db, mail: MailApi, user: User, days: number): Promise<number> {
  const ids = await mail.listMessageIds(`newer_than:${Math.max(1, Math.floor(days))}d in:inbox`, BACKFILL_MAX);
  return enqueueMessages(db, user, ids, true);
}

/**
 * Claude で分類できていないメール（分類に失敗したもの・一斉配信として分類を省いたもの）を分類し直す。
 * 人が直したもの（フォルダの移動・アーカイブ・迷惑メール・ゴミ箱）とルールで決まったものは触らない。
 * 返信済み・下書きありは、分類し直しても要返信／新着に戻さない。Gmail の古いラベルはジョブの中で外す。
 */
function unclassifiedConds(user: User) {
  return and(
    eq(messages.userId, user.id),
    isNull(messages.confidence),
    notInArray(messages.source, ["sender_rule", "domain_rule", "manual"]),
    notInArray(messages.status, ["archived", "skipped"]),
  );
}

export async function countUnclassified(db: Db, user: User): Promise<number> {
  const rows = await db.select({ id: messages.id }).from(messages).where(unclassifiedConds(user));
  return rows.length;
}

export async function requeueUnclassified(db: Db, user: User, now = new Date()): Promise<number> {
  const rows = await db.select().from(messages).where(unclassifiedConds(user));
  let n = 0;
  const stamp = now.getTime().toString(36);
  for (const row of rows) {
    const removeLabels = [
      ...[row.folder, ...row.secondaryFolders].filter(isFolder).map(folderLabelName),
      STATUS_LABELS.needsReview,
      STATUS_LABELS.needsReply,
    ];
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx
        .delete(dateCandidates)
        .where(
          and(
            eq(dateCandidates.userId, user.id),
            eq(dateCandidates.gmailMessageId, row.gmailMessageId),
            eq(dateCandidates.status, "candidate"),
          ),
        );
      await tx.delete(messages).where(eq(messages.id, row.id));
      await enqueue(
        tx,
        "process_message",
        {
          userId: user.id,
          messageId: row.gmailMessageId,
          backfill: true,
          removeLabels,
          ...(row.status === "replied" || row.status === "draft_ready" ? { keepStatus: row.status } : {}),
        },
        `reclassify:${user.id}:${row.gmailMessageId}:${stamp}`,
      );
    });
    n++;
  }
  return n;
}
