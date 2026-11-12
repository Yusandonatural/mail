import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "./db";
import { users, type User } from "./db/schema";
import { ClaudeClassifier } from "./claude/classifier";
import { ClaudeDraftWriter } from "./claude/drafter";
import { GoogleMailApi } from "./google/gmail";
import { GoogleCalendarApi } from "./google/calendar";
import { clientForRefreshToken } from "./google/oauth";
import { MessageNotFoundError, type MailApi } from "./google/mail-api";
import { LabelResolver } from "./labels";
import type { CalendarApi } from "./google/calendar-api";
import { markRepliedLabels, processMessage } from "./pipeline";
import { generateDraft } from "./drafts";
import { collectSummaries } from "./contacts";
import { PermanentJobError, RetryLaterError, type JobHandlers } from "./jobs";
import { isInvalidGrant } from "./google/errors";
import { shopFromEnv } from "./shopify";
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
  return { db, mail: mailFor(user), drafter, calendar: calendarFor(user), shop: shopFromEnv() };
}

export function pipelineDeps(db: Db, user: User) {
  return { db, mail: mailFor(user), classifier };
}

async function loadUser(db: Db, id: unknown): Promise<User> {
  const user = (await db.select().from(users).where(eq(users.id, Number(id))).limit(1))[0];
  if (!user || !user.active) throw new PermanentJobError(`利用者 ${String(id)} が見つかりません`);
  return user;
}

/** Google の連携が切れている間、ジョブを失敗にせず、この間隔で様子を見る（ログインし直せばすぐ動く） */
export const GOOGLE_RECONNECT_WAIT_MS = 30 * 60 * 1000;

/**
 * リフレッシュトークンが無効になった利用者の連携を外す。cron・push の同期とジョブはこの人を飛ばし、
 * 画面の上に「ログインし直してください」と出す。ログインし直すと新しいトークンが入る。
 * 外す前にログインし直していれば（トークンが入れ替わっていれば）新しいトークンは消さない
 */
export async function markGoogleDisconnected(db: Db, user: User): Promise<void> {
  if (!user.refreshTokenEnc) return;
  console.error(`${user.email} の Google 連携が切れました（invalid_grant）。ログインし直すまで同期を止めます`);
  await db
    .update(users)
    .set({ refreshTokenEnc: null })
    .where(and(eq(users.id, user.id), eq(users.refreshTokenEnc, user.refreshTokenEnc)));
}

/**
 * Gmail を使うジョブ。連携が切れていればジョブを捨てずに後ろへずらす（何度も失敗させて取りこぼさない。
 * ほかの人のジョブや cron の時間も食わない）
 */
async function withGoogleUser(db: Db, id: unknown, fn: (user: User) => Promise<void>): Promise<void> {
  const user = await loadUser(db, id);
  if (!user.refreshTokenEnc) throw new RetryLaterError(GOOGLE_RECONNECT_WAIT_MS);
  try {
    await fn(user);
  } catch (err) {
    if (!isInvalidGrant(err)) throw err;
    await markGoogleDisconnected(db, user);
    throw new RetryLaterError(GOOGLE_RECONNECT_WAIT_MS);
  }
}

/** Claude の混雑が続くとき、何回目の実行から分類を諦めて「要確認」で取り込むか（それまでの待ちは約 6 分） */
const CLASSIFY_FALLBACK_ATTEMPT = 3;

export function jobHandlers(db: Db): JobHandlers {
  return {
    process_message: (p, job) => withGoogleUser(db, p.userId, async (user) => {
      const deps = pipelineDeps(db, user);
      // 分類し直すときは、前の分類で付けたラベルを先に外す
      if (Array.isArray(p.removeLabels) && p.removeLabels.length) {
        const labels = new LabelResolver(deps.mail);
        const ids = (await Promise.all(p.removeLabels.map((name) => labels.existingId(String(name))))).filter(
          (x): x is string => Boolean(x),
        );
        if (ids.length) {
          await deps.mail.modifyMessage(String(p.messageId), [], ids).catch((err) => {
            if (!(err instanceof MessageNotFoundError) && (err as { code?: number }).code !== 404) throw err;
          });
        }
      }
      const keepStatus = p.keepStatus === "replied" || p.keepStatus === "draft_ready" ? p.keepStatus : undefined;
      await processMessage(deps, user, String(p.messageId), {
        autoDraft: p.backfill !== true,
        keepStatus,
        fallbackOnBusy: (job?.attempts ?? 1) >= CLASSIFY_FALLBACK_ATTEMPT,
      });
    }),
    // グループ宛てのメールに同僚が返信したとき、その人の Gmail でも要返信を外す
    mark_replied: (p) => withGoogleUser(db, p.userId, async (user) => {
      await markRepliedLabels(mailFor(user), [String(p.messageId)]);
    }),
    generate_draft: (p) => withGoogleUser(db, p.userId, async (user) => {
      await generateDraft(draftDeps(db, user), user, String(p.threadId), p.messageId ? String(p.messageId) : null, {
        generatedBy: p.generatedBy === "manual" ? "manual" : "auto",
        instruction: typeof p.instruction === "string" ? p.instruction : null,
      });
    }),
    collect_summary_batch: async (p) => collectSummaries(db, p),
    notify: async (p) => {
      if (!pushConfigured()) return;
      await notifyUser(db, new WebPushNotifier(), Number(p.userId), p as unknown as PushPayload);
    },
  };
}

export { getDb };
