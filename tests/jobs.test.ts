import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { claimNext, enqueue, PermanentJobError, RetryLaterError, runJobs } from "@/lib/jobs";
import { jobs } from "@/lib/db/schema";
import { testDb } from "./helpers/db";

describe("ジョブキュー", () => {
  it("同じ重複キーは1回しか積まない", async () => {
    const db = await testDb();
    expect(await enqueue(db, "process_message", { a: 1 }, "k1")).toBe(true);
    expect(await enqueue(db, "process_message", { a: 2 }, "k1")).toBe(false);
    const job = await claimNext(db);
    expect(job).toMatchObject({ kind: "process_message", payload: { a: 1 }, attempts: 1 });
    expect(await claimNext(db)).toBeNull();
  });

  it("失敗はバックオフして再実行、恒久的な失敗は failed", async () => {
    const db = await testDb();
    await enqueue(db, "process_message", {}, "retry");
    await enqueue(db, "generate_draft", {}, "perm");
    const noop = async () => {};
    const n = await runJobs(
      db,
      {
        process_message: async () => {
          throw new Error("一時的なエラー");
        },
        generate_draft: async () => {
          throw new PermanentJobError("ダメ");
        },
        collect_summary_batch: noop,
      },
      5000,
    );
    expect(n).toBe(2);
    const rows = await db.select().from(jobs);
    const retry = rows.find((r) => r.dedupeKey === "retry")!;
    const perm = rows.find((r) => r.dedupeKey === "perm")!;
    expect(retry).toMatchObject({ status: "pending", lastError: "一時的なエラー" });
    expect(retry.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(perm.status).toBe("failed");
  });

  it("RetryLaterError は失敗にせず後ろにずらす", async () => {
    const db = await testDb();
    await enqueue(db, "collect_summary_batch", {}, "batch");
    const noop = async () => {};
    await runJobs(
      db,
      {
        process_message: noop,
        generate_draft: noop,
        collect_summary_batch: async () => {
          throw new RetryLaterError(60_000);
        },
      },
      5000,
    );
    const [row] = await db.select().from(jobs).where(eq(jobs.dedupeKey, "batch"));
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
  });
});
