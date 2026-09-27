import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { messages, users, type User } from "./db/schema";
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

/** 過去のメールをさかのぼって分類する（管理画面から実行） */
export async function backfill(db: Db, mail: MailApi, user: User, days: number): Promise<number> {
  const ids = await mail.listMessageIds(`newer_than:${Math.max(1, Math.floor(days))}d in:inbox`, 2000);
  return enqueueMessages(db, user, ids, true);
}
