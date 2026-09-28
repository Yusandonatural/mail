"use server";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { drafts } from "@/lib/db/schema";
import { LANGUAGES, type Language } from "@/lib/domain";
import { parseMessage, stripQuoted } from "@/lib/mail/parse";
import { mailFor } from "@/lib/services";
import { getSetting } from "@/lib/settings";
import { requireUser } from "@/lib/session";
import { ClaudeTranslator, isMostlyJapanese, translateIncoming, translateReply } from "@/lib/translate";
import { errorResult, ownMessage, type ActionResult } from "./common";

const translator = new ClaudeTranslator();

/** スレッド内の1通を日本語に訳す（開いたときに下に表示する） */
export async function translateMessageAction(
  rowId: number,
  gmailMessageId: string,
): Promise<ActionResult<{ subject: string; body: string } | null>> {
  try {
    const { user, row } = await ownMessage(rowId);
    const m = parseMessage(await mailFor(user).getMessage(gmailMessageId));
    // 同じスレッドのメールだけ（ほかのメールを訳させない）
    if (m.threadId !== row.gmailThreadId) return { ok: false, error: "このスレッドのメールではありません" };
    const body = (stripQuoted(m.text) || m.text).slice(0, 12000);
    if (isMostlyJapanese(body)) return { ok: true, data: null };
    return { ok: true, data: await translateIncoming(translator, { subject: m.subject, body }) };
  } catch (err) {
    return errorResult(err);
  }
}

/** 日本語で書いた返信を、選んだ言語に訳す。下書き欄に入れるだけで、保存・送信はしない */
export async function translateReplyAction(
  draftRowId: number,
  text: string,
  target: string,
): Promise<ActionResult<{ text: string }>> {
  try {
    const user = await requireUser();
    if (!(LANGUAGES as readonly string[]).includes(target)) return { ok: false, error: "翻訳先の言語が正しくありません" };
    if (!text.trim()) return { ok: false, error: "訳す文章がありません" };
    const db = await getDb();
    const own = await db
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.id, draftRowId), eq(drafts.userId, user.id)))
      .limit(1);
    if (!own.length) return { ok: false, error: "下書きが見つかりません" };
    const signatures = await getSetting(db, "signatures");
    const translated = await translateReply(translator, {
      text,
      target: target as Language,
      signatures: { ja: signatures.ja, en: signatures.en },
    });
    return { ok: true, data: { text: translated } };
  } catch (err) {
    return errorResult(err);
  }
}
