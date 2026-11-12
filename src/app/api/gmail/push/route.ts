import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { verifyPubSubToken } from "@/lib/google/oauth";
import { runJobs } from "@/lib/jobs";
import { jobHandlers, mailFor, markGoogleDisconnected } from "@/lib/services";
import { isInvalidGrant } from "@/lib/google/errors";
import { syncUser } from "@/lib/sync";

export const maxDuration = 300;

/** Gmail → Pub/Sub → この URL。受信から数秒で分類する（仕様書 4章） */
export async function POST(req: NextRequest) {
  if (!(await verifyPubSubToken(req.headers.get("authorization")))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { message?: { data?: string } } | null;
  const data = body?.message?.data;
  if (!data) return new NextResponse(null, { status: 204 });
  let notice: { emailAddress?: string };
  try {
    notice = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const email = notice.emailAddress?.toLowerCase();
  if (!email) return new NextResponse(null, { status: 204 });

  const db = await getDb();
  const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user || !user.active || !user.refreshTokenEnc) return new NextResponse(null, { status: 204 });

  try {
    await syncUser(db, mailFor(user), user);
  } catch (err) {
    // 失敗しても 204 を返す（500 を返すと Pub/Sub が送り直し続ける）。履歴 ID は進んでいないので、
    // 次の通知か 5 分ごとの cron が同じ範囲から読み直す。トークンが無効なら連携を外してログインし直してもらう
    if (isInvalidGrant(err)) await markGoogleDisconnected(db, user);
    else console.error("push sync failed for", user.email, err);
    return new NextResponse(null, { status: 204 });
  }
  // 重い処理（下書き生成）が残っても、次の通知か 5 分ごとの cron で続きを行う
  await runJobs(db, jobHandlers(db), 20_000);
  return new NextResponse(null, { status: 204 });
}
