import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { exchangeCode } from "@/lib/google/oauth";
import { createSession, takeOAuthState } from "@/lib/session";
import { audit } from "@/lib/audit";
import { mailFor } from "@/lib/services";
import { ensureWatch, syncUser } from "@/lib/sync";

function fail(message: string) {
  const url = new URL("/login", config().APP_BASE_URL);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = await takeOAuthState();
  if (!code || !state || state !== expected) return fail("ログインをやり直してください");

  let login;
  try {
    login = await exchangeCode(code);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "ログインに失敗しました");
  }

  const db = await getDb();
  let user = (await db.select().from(users).where(eq(users.email, login.email)).limit(1))[0];
  if (!user) {
    if (!config().adminEmails.includes(login.email)) {
      return fail(`${login.email} はまだ登録されていません。管理者に追加を依頼してください`);
    }
    [user] = await db.insert(users).values({ email: login.email, role: "admin" }).returning();
  }
  if (!user.active) return fail("このアカウントは無効になっています");
  if (!login.refreshToken && !user.refreshTokenEnc) return fail("Google の権限を取得できませんでした。もう一度お試しください");

  [user] = await db
    .update(users)
    .set({
      name: login.name,
      googleSub: login.sub,
      ...(login.refreshToken ? { refreshTokenEnc: encryptSecret(login.refreshToken) } : {}),
    })
    .where(eq(users.id, user.id))
    .returning();

  try {
    const mail = mailFor(user);
    await ensureWatch(db, mail, user, config().GMAIL_PUBSUB_TOPIC);
    const refreshed = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
    await syncUser(db, mail, refreshed);
  } catch (err) {
    console.error("gmail watch/sync on login failed", err);
  }

  await audit(db, user.id, "login", user.email);
  await createSession(user.id);
  return NextResponse.redirect(new URL("/inbox", config().APP_BASE_URL));
}
