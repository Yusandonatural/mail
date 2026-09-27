"use server";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { pushSubscriptions } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";

export async function savePushSubscription(sub: { endpoint: string; p256dh: string; auth: string; userAgent: string }): Promise<void> {
  const user = await requireUser();
  if (!/^https:\/\//.test(sub.endpoint) || !sub.p256dh || !sub.auth) throw new Error("通知の登録内容が正しくありません");
  const db = await getDb();
  const values = { userId: user.id, p256dh: sub.p256dh, auth: sub.auth, userAgent: sub.userAgent.slice(0, 300) };
  await db
    .insert(pushSubscriptions)
    .values({ endpoint: sub.endpoint, ...values })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, user.id)));
}
