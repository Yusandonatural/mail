import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { jobs } from "./db/schema";
import { ClaudeRefusalError, isRetryableApiError } from "./claude/client";
import { isGooglePermanent, isGoogleTransient } from "./google/errors";

export type JobKind = "process_message" | "generate_draft" | "collect_summary_batch" | "notify" | "mark_replied";

export interface ClaimedJob {
  id: number;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
}

/** リトライしても結果が変わらない失敗 */
export class PermanentJobError extends Error {}

/** まだ結果が出ていないので、失敗扱いにせず後でもう一度実行する（バッチの回収など） */
export class RetryLaterError extends Error {
  constructor(public delayMs: number) {
    super("retry later");
  }
}

const MAX_ATTEMPTS = 5;
/**
 * Claude の混雑（429/529）や Gmail の使いすぎ・一時的な障害は数時間続くことがあるので、
 * 間隔を最大 1 時間まで延ばしながら長めに（合計およそ 5 時間）やり直す。すぐ諦めると自動の下書きが失われる
 */
const MAX_TRANSIENT_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** 時間をおけば通る失敗か（Claude・Google の混雑や一時的な障害） */
export function isTransientError(err: unknown): boolean {
  return isRetryableApiError(err) || isGoogleTransient(err);
}

export async function enqueue(
  db: Db,
  kind: JobKind,
  payload: Record<string, unknown>,
  dedupeKey: string,
  runAfter: Date = new Date(),
): Promise<boolean> {
  // 同じキーのジョブが「失敗」で終わっていれば、積み直す（取り込みのやり直しで拾えるように）
  const rows = await db
    .insert(jobs)
    .values({ kind, payload, dedupeKey, runAfter })
    .onConflictDoUpdate({
      target: jobs.dedupeKey,
      set: { status: "pending", attempts: 0, runAfter, lastError: null, payload },
      setWhere: sql`${jobs.status} = 'failed'`,
    })
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** 実行できるジョブを1件取り出す。10分以上止まっている running も拾い直す */
export async function claimNext(db: Db, now: Date = new Date()): Promise<ClaimedJob | null> {
  const stale = new Date(now.getTime() - 10 * 60 * 1000);
  const res = await db.execute(sql`
    update jobs set status = 'running', locked_at = ${now.toISOString()}::timestamptz, attempts = attempts + 1
    where id = (
      select id from jobs
      where ((status = 'pending' and run_after <= ${now.toISOString()}::timestamptz)
         or (status = 'running' and locked_at < ${stale.toISOString()}::timestamptz))
        -- 同じスレッドの下書きを2つの処理（push と cron など）が同時に作ると、Gmail に下書きが2つできる。
        -- 実行中のものがあれば、終わるまで待つ
        and not (kind = 'generate_draft' and exists (
          select 1 from jobs r
          where r.kind = 'generate_draft' and r.status = 'running' and r.id <> jobs.id
            and r.locked_at >= ${stale.toISOString()}::timestamptz
            and r.payload->>'userId' = jobs.payload->>'userId'
            and r.payload->>'threadId' = jobs.payload->>'threadId'))
      -- 新しく届いたメールを、過去メールの取り込みより先に処理する
      order by (payload ? 'backfill') , run_after, id
      limit 1
      for update skip locked
    )
    returning id, kind, payload, attempts`);
  const row = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind as JobKind,
    payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
    attempts: Number(row.attempts),
  };
}

export type JobHandlers = Record<JobKind, (payload: Record<string, unknown>, job: ClaimedJob) => Promise<void>>;

export async function finishJob(db: Db, id: number): Promise<void> {
  await db.execute(sql`update jobs set status = 'done', locked_at = null, last_error = null where id = ${id}`);
}

export async function failJob(db: Db, job: ClaimedJob, err: unknown, now: Date = new Date()): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // Gmail の 404（メールが消えた）・403（権限が足りない）なども、やり直しても通らない
  const permanent = err instanceof PermanentJobError || err instanceof ClaudeRefusalError || isGooglePermanent(err);
  const maxAttempts = isTransientError(err) ? MAX_TRANSIENT_ATTEMPTS : MAX_ATTEMPTS;
  if (permanent || job.attempts >= maxAttempts) {
    await db.execute(
      sql`update jobs set status = 'failed', locked_at = null, last_error = ${message} where id = ${job.id}`,
    );
    return;
  }
  const retryAt = new Date(now.getTime() + Math.min(MAX_BACKOFF_MS, 2 ** job.attempts * 60 * 1000));
  await db.execute(sql`
    update jobs set status = 'pending', locked_at = null, last_error = ${message},
      run_after = ${retryAt.toISOString()}::timestamptz
    where id = ${job.id}`);
}

/** 制限時間内でジョブを順に実行する。実行した件数を返す */
export async function runJobs(db: Db, handlers: JobHandlers, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let count = 0;
  while (Date.now() < deadline) {
    const job = await claimNext(db);
    if (!job) break;
    try {
      await handlers[job.kind](job.payload, job);
      await finishJob(db, job.id);
    } catch (err) {
      if (err instanceof RetryLaterError) {
        await rescheduleJob(db, job.id, new Date(Date.now() + err.delayMs));
      } else {
        console.error(`job ${job.id} (${job.kind}) failed:`, err);
        await failJob(db, job, err);
      }
    }
    count++;
  }
  return count;
}

/** 結果を待ってから再実行する種類のジョブ（バッチの回収など）を後ろにずらす */
export async function rescheduleJob(db: Db, id: number, runAfter: Date): Promise<void> {
  await db.execute(sql`
    update jobs set status = 'pending', locked_at = null, attempts = 0,
      run_after = ${runAfter.toISOString()}::timestamptz
    where id = ${id}`);
}

/**
 * Google にログインし直した利用者の、保留していたジョブ（連携が切れている間に後ろへずらしたもの）をすぐ動かす
 */
export async function resumeUserJobs(db: Db, userId: number, now: Date = new Date()): Promise<void> {
  await db.execute(sql`
    update jobs set run_after = ${now.toISOString()}::timestamptz
    where status = 'pending' and run_after > ${now.toISOString()}::timestamptz
      and payload->>'userId' = ${String(userId)}`);
}
