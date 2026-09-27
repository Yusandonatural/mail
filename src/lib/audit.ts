import type { Db } from "./db";
import { auditLog } from "./db/schema";

export type AuditAction =
  | "login"
  | "draft_generated"
  | "draft_saved"
  | "mail_sent"
  | "folder_moved"
  | "rule_created"
  | "rule_deleted"
  | "event_created"
  | "event_confirmed"
  | "archived"
  | "spam"
  | "trashed"
  | "settings_changed"
  | "user_changed"
  | "backfill"
  | "freee_uploaded";

export async function audit(
  db: Db,
  userId: number | null,
  action: AuditAction,
  target = "",
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({ userId, action, target, detail });
}
