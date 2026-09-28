import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "./db";
import { dateCandidates, messages, users, type User } from "./db/schema";
import { folderLabelName, isFolder, STATUS_LABELS } from "./domain";
import { HistoryExpiredError, type MailApi } from "./google/mail-api";
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
  try {
    const { messageIds, readIds, historyId } = await mail.listHistory(user.historyId);
    const n = await enqueueMessages(db, user, messageIds);
    if (readIds.length) {
      await db
        .update(messages)
        .set({ unread: false })
        .where(and(eq(messages.userId, user.id), inArray(messages.gmailMessageId, readIds)));
    }
    await db.update(users).set({ historyId }).where(eq(users.id, user.id));
    return n;
  } catch (err) {
    if (!(err instanceof HistoryExpiredError)) throw err;
    // 履歴が古すぎる：直近2日分を拾い直す（処理済みは重複キーで弾かれる）
    const ids = await mail.listMessageIds("newer_than:2d -in:drafts", 500);
    const n = await enqueueMessages(db, user, ids);
    const profile = await mail.getProfile();
    await db.update(users).set({ historyId: profile.historyId }).where(eq(users.id, user.id));
    return n;
  }
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
 * 人が直したものとルールで決まったものは触らない。Gmail の古いラベルはジョブの中で外す。
 */
export async function countUnclassified(db: Db, user: User): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.userId, user.id),
        isNull(messages.confidence),
        notInArray(messages.source, ["sender_rule", "domain_rule", "manual"]),
      ),
    );
  return rows.length;
}

export async function requeueUnclassified(db: Db, user: User, now = new Date()): Promise<number> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, user.id),
        isNull(messages.confidence),
        notInArray(messages.source, ["sender_rule", "domain_rule", "manual"]),
      ),
    );
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
        { userId: user.id, messageId: row.gmailMessageId, backfill: true, removeLabels },
        `reclassify:${user.id}:${row.gmailMessageId}:${stamp}`,
      );
    });
    n++;
  }
  return n;
}
