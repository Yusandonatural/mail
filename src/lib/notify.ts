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

/** ブラウザの通知サービス（Chrome/Edge/Firefox/Safari）のホスト */
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

/**
 * 通知の宛先として受け付ける URL か。サーバーがこの URL に POST するので、
 * 任意の URL を登録されると内部のサービスなどへリクエストを送らされてしまう（SSRF）
 */
export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string") return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && PUSH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export class WebPushNotifier implements Notifier {
  async send(sub: PushSubscriptionRow, payload: PushPayload): Promise<"ok" | "gone"> {
    // 通知サービス以外の宛先（チェックを入れる前に登録されたもの）には送らず、消してもらう
    if (!isPushEndpoint(sub.endpoint)) return "gone";
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
    // 1台で失敗しても、ほかの端末には送る
    try {
      const r = await notifier.send(sub, payload);
      if (r === "gone") await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
      else sent++;
    } catch (err) {
      console.error("push failed", sub.endpoint, err);
    }
  }
  return sent;
}
