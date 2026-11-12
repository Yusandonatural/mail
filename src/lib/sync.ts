import { and, eq, inArray, isNull, max, ne, notInArray, or } from "drizzle-orm";
import type { Db } from "./db";
import { drafts, messages, users, type User } from "./db/schema";
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
      // Gmail を読む処理はロックを持つ前に済ませる（Gmail の応答を待つ間、行のロックと DB の接続を握り続けないように）
      const sentTimes = await threadSentTimes(db, mail, user, changes.inboxIds ?? []);
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
        const relabel = await applyGmailChanges(tx, user, changes, sentTimes);
        await tx.update(users).set({ historyId }).where(eq(users.id, user.id));
        return { queued: n, relabel };
      });
      if (result.queued !== undefined) {
        // Gmail の「要返信」「下書きあり」を外すのは、記録が確定しロックを放した後（失敗しても一覧はアーカイブのまま。
        // ラベルは次に人が触るまで残る）
        await markRepliedLabels(mail, result.relabel).catch((err) =>
          console.error("label archived messages failed", user.id, err),
        );
        return result.queued;
      }
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
 * 受信トレイに戻されたアーカイブ済みのメールについて、スレッドで自分たちが送った時刻（スレッドごと）を Gmail から読む。
 * 読めなかったスレッドは空（返信なし）として扱う
 */
async function threadSentTimes(db: Db, mail: MailApi, user: User, inboxIds: string[]): Promise<Map<string, number[]>> {
  const sentAt = new Map<string, number[]>();
  if (!inboxIds.length) return sentAt;
  const rows = await db
    .select({ threadId: messages.gmailThreadId })
    .from(messages)
    .where(and(eq(messages.userId, user.id), inArray(messages.gmailMessageId, inboxIds), eq(messages.status, "archived")));
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
  return sentAt;
}

/**
 * 人が Gmail（ウェブ・スマホ）で直接行った操作を一覧に反映する。DB だけを変え、Gmail は呼ばない（ロックの中で呼ぶため）。
 * アプリ自身のアーカイブ・迷惑メール・ゴミ箱も同じ履歴で届くが、その行は既に archived / skipped なので何も変わらない。
 * 戻り値は、Gmail の「要返信」「下書きあり」を外して対応済にするメール（今は無し。呼び出し側の形を保つため残す）
 */
async function applyGmailChanges(
  db: Db,
  user: User,
  changes: HistoryChanges,
  sentTimes: Map<string, number[]>,
): Promise<string[]> {
  const { unreadIds = [], archivedIds = [], inboxIds = [], trashedIds = [], deletedIds = [] } = changes;
  const mine = (ids: string[]) => and(eq(messages.userId, user.id), inArray(messages.gmailMessageId, ids));
  const relabel: string[] = [];
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
  // スキップしたものなど）は INBOX が外れる履歴が無いので含まれない。
  // Gmail のスヌーズも受信トレイから外れるだけで区別できないので、「要返信」は消さずに残し、
  // Gmail のラベルにも触らない（スヌーズが明けて受信トレイに戻ったら、要返信のまま一覧に戻す）
  if (archivedIds.length) {
    await db
      .update(messages)
      .set({ status: "archived" })
      .where(and(mine(archivedIds), notInArray(messages.status, ["archived", "skipped"])));
  }

  // 受信トレイに戻された：アーカイブした行を一覧に戻す。このメールより後に自分たちの返信がスレッドにあれば返信済。
  // 無ければ、要返信が残っていれば要返信（下書きがあれば下書きあり）、そうでなければ対応済にする
  if (inboxIds.length) {
    const rows = await db
      .select({ id: messages.id, threadId: messages.gmailThreadId, receivedAt: messages.receivedAt, needsReply: messages.needsReply })
      .from(messages)
      .where(and(mine(inboxIds), eq(messages.status, "archived")));
    const withDraft = new Set(
      rows.length
        ? (
            await db
              .select({ threadId: drafts.gmailThreadId })
              .from(drafts)
              .where(and(eq(drafts.userId, user.id), inArray(drafts.gmailThreadId, rows.map((r) => r.threadId)), eq(drafts.status, "ready")))
          ).map((d) => d.threadId)
        : [],
    );
    const groups: Record<"replied" | "done" | "new" | "draft_ready", number[]> = { replied: [], done: [], new: [], draft_ready: [] };
    for (const r of rows) {
      const answered = (sentTimes.get(r.threadId) ?? []).some((t) => t >= r.receivedAt.getTime());
      if (answered) groups.replied.push(r.id);
      else if (r.needsReply) groups[withDraft.has(r.threadId) ? "draft_ready" : "new"].push(r.id);
      else groups.done.push(r.id);
    }
    for (const [status, ids] of Object.entries(groups)) {
      if (!ids.length) continue;
      await db
        .update(messages)
        .set(status === "replied" || status === "done" ? { status, needsReply: false } : { status })
        .where(and(inArray(messages.id, ids), eq(messages.status, "archived")));
    }
  }
  return relabel;
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
    // 一斉配信として Claude を使わずにニュースレターへ入れたものは、分類し直しても変わらないので除く
    or(eq(messages.needsReview, true), ne(messages.folder, "info")),
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
    // 行は消さずに残し、分類し直した結果で置き換える（順番待ちの間も一覧から消えない）。
    // 新しく届いたメールと同じ順番で処理し、下書き・通知は作らない
    const queued = await enqueue(
      db,
      "process_message",
      {
        userId: user.id,
        messageId: row.gmailMessageId,
        reclassify: true,
        removeLabels,
        ...(row.status === "replied" || row.status === "draft_ready" ? { keepStatus: row.status } : {}),
      },
      `reclassify:${user.id}:${row.gmailMessageId}:${stamp}`,
    );
    if (!queued) continue;
    n++;
  }
  return n;
}
