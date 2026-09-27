import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { getDb } from "./db";
import { users, type User } from "./db/schema";
import { config } from "./config";

const COOKIE = "ym_session";
const MAX_AGE = 30 * 24 * 60 * 60;

function secret(): Uint8Array {
  return new TextEncoder().encode(config().SESSION_SECRET);
}

function secureCookies(): boolean {
  return config().APP_BASE_URL.startsWith("https://");
}

export async function createSession(userId: number): Promise<void> {
  const token = await new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const uid = Number(payload.uid);
    const db = await getDb();
    const user = (await db.select().from(users).where(eq(users.id, uid)).limit(1))[0];
    return user && user.active ? user : null;
  } catch {
    return null;
  }
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/inbox");
  return user;
}

export const OAUTH_STATE_COOKIE = "ym_oauth_state";

export async function setOAuthState(state: string): Promise<void> {
  (await cookies()).set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 600,
  });
}

export async function takeOAuthState(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(OAUTH_STATE_COOKIE)?.value ?? null;
  store.delete(OAUTH_STATE_COOKIE);
  return value;
}
