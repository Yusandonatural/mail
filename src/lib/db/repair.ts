import { eq, or, sql } from "drizzle-orm";
import type { Db } from "./index";
import { contacts, messages } from "./schema";
import { decodeHeaderText } from "../mail/parse";

/** 符号のまま（=?...?=）か、1 バイトずつ Latin-1 として読まれた（U+0080〜U+00FF が続く）文字列 */
const suspect = (col: typeof messages.subject | typeof messages.fromName | typeof contacts.name) =>
  sql`(${col} like '%=?%' or ${col} ~ '[\u0080-ÿ]{2}')`;

/**
 * 文字化けしたまま保存された件名・差出人名を直す（読み込みの修正より前に取り込んだメールの分）。
 * 何度実行してもよい。直した件数を返す。
 */
export async function repairStoredHeaders(db: Db): Promise<number> {
  let fixed = 0;
  const rows = await db
    .select({ id: messages.id, subject: messages.subject, fromName: messages.fromName })
    .from(messages)
    .where(or(suspect(messages.subject), suspect(messages.fromName)));
  for (const r of rows) {
    const subject = decodeHeaderText(r.subject);
    const fromName = r.fromName ? decodeHeaderText(r.fromName) : r.fromName;
    if (subject === r.subject && fromName === r.fromName) continue;
    await db.update(messages).set({ subject, fromName }).where(eq(messages.id, r.id));
    fixed++;
  }
  const people = await db.select({ email: contacts.email, name: contacts.name }).from(contacts).where(suspect(contacts.name));
  for (const p of people) {
    const name = p.name ? decodeHeaderText(p.name) : p.name;
    if (name === p.name) continue;
    await db.update(contacts).set({ name }).where(eq(contacts.email, p.email));
    fixed++;
  }
  return fixed;
}
