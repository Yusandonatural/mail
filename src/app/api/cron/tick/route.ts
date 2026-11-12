import { NextResponse, type NextRequest } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { cronAuthorized } from "@/lib/cron-auth";
import { runJobs } from "@/lib/jobs";
import { jobHandlers, mailFor } from "@/lib/services";
import { ensureWatch, syncUser } from "@/lib/sync";
import { adoptGmailDrafts } from "@/lib/drafts";

export const maxDuration = 300;

/**
 * 5 分ごと（Cloud Scheduler）：push 通知の取りこぼしを拾い、watch を更新し、
 * Gmail で作られた返信下書きを取り込み、残ったジョブを進める。
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const started = Date.now();
  const db = await getDb();
  const active = await db
    .select()
    .from(users)
    .where(and(eq(users.active, true), isNotNull(users.refreshTokenEnc)));
  const results: Record<string, string> = {};
  for (const user of active) {
    try {
      const mail = mailFor(user);
      // watch の更新に失敗しても（Pub/Sub の権限など）、取りこぼしの同期は続ける。
      // ここで止めると push も届かないので、メールが一切取り込まれなくなる
      await ensureWatch(db, mail, user, config().GMAIL_PUBSUB_TOPIC).catch((e) => {
        console.error("watch renew failed for", user.email, e);
      });
      const fresh = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
      const queued = await syncUser(db, mail, fresh);
      // Claude のスキルなどで Gmail に作られた返信下書きを取り込み、受信箱の一番上に出す
      const adopted = await adoptGmailDrafts(db, mail, fresh).catch((e) => {
        console.error("adopt drafts failed for", user.email, e);
        return 0;
      });
      results[user.email] = `queued ${queued}, drafts adopted ${adopted}`;
    } catch (err) {
      console.error("tick failed for", user.email, err);
      results[user.email] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // 同期に使った時間を差し引き、maxDuration（300 秒）の途中でジョブが打ち切られないようにする
  const budget = Math.max(0, 240_000 - (Date.now() - started));
  const ran = budget > 0 ? await runJobs(db, jobHandlers(db), budget) : 0;
  return NextResponse.json({ users: results, jobsRun: ran });
}
