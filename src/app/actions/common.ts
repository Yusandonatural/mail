import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { messages, type MessageRow, type User } from "@/lib/db/schema";
import { canSeeMessage } from "@/lib/access";
import { requireUser } from "@/lib/session";

export async function ownMessage(rowId: number): Promise<{ user: User; row: MessageRow }> {
  const user = await requireUser();
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, rowId), eq(messages.userId, user.id)))
      .limit(1)
  )[0];
  if (!row || !canSeeMessage(user, row)) throw new Error("メールが見つかりません");
  return { user, row };
}

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export function errorResult(err: unknown): { ok: false; error: string } {
  console.error(err);
  return { ok: false, error: err instanceof Error ? err.message : "処理に失敗しました" };
}
