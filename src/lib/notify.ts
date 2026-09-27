import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { pushSubscriptions, type PushSubscriptionRow } from "./db/schema";

/**
 * スマホ・パソコンへの通知（Web Push）。仕様書 4章「緊急度 → 一覧の並び順と通知」。
 * 鍵が無ければ何もしない。
 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface Notifier {
  /** gone = 宛先が無効になった（購読が解除された・期限切れ） */
  send(sub: PushSubscriptionRow, payload: PushPayload): Promise<"ok" | "gone">;
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export class WebPushNotifier implements Notifier {
  async send(sub: PushSubscriptionRow, payload: PushPayload): Promise<"ok" | "gone"> {
    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || `mailto:${(process.env.ADMIN_EMAILS ?? "").split(",")[0] || "admin@example.com"}`,
      process.env.VAPID_PUBLIC_KEY ?? "",
      process.env.VAPID_PRIVATE_KEY ?? "",
    );
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 },
      );
      return "ok";
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) return "gone";
      throw err;
    }
  }
}

/** 利用者の全ての端末に送る。無効になった宛先は消す。送れた件数を返す */
export async function notifyUser(db: Db, notifier: Notifier, userId: number, payload: PushPayload): Promise<number> {
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  let sent = 0;
  for (const sub of subs) {
    const r = await notifier.send(sub, payload);
    if (r === "gone") await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
    else sent++;
  }
  return sent;
}
