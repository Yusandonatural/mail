import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

/** Cloud Scheduler からの呼び出しを Authorization: Bearer <CRON_SECRET> で確かめる */
export function cronAuthorized(authorization: string | null): boolean {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const expected = config().CRON_SECRET;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
