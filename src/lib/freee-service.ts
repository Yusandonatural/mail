import { eq, or } from "drizzle-orm";
import type { Db } from "./db";
import { freeeUploads, type MessageRow, type User } from "./db/schema";
import { FREEE_RECEIPT_TYPES, FreeeNotConnectedError, type FreeeApi } from "./freee";
import type { MailApi } from "./google/mail-api";
import { LabelResolver } from "./labels";
import { parseMessage } from "./mail/parse";
import { getSetting } from "./settings";
import { jstDateString } from "./time";

export function uploadKey(row: Pick<MessageRow, "rfcMessageId" | "gmailMessageId">, filename: string): string {
  return `${row.rfcMessageId ?? row.gmailMessageId}:${filename}`;
}

/** freee のファイルボックスで見分けやすい説明（送り主・件名・金額・期限） */
export function receiptDescription(
  row: Pick<MessageRow, "fromName" | "fromEmail" | "subject" | "amount" | "currency" | "dueDate">,
): string {
  const amount =
    row.amount === null
      ? null
      : !row.currency || row.currency === "JPY"
        ? `¥${row.amount.toLocaleString("ja-JP")}`
        : `${row.amount} ${row.currency}`;
  return [row.fromName || row.fromEmail, row.subject, amount, row.dueDate ? `期限 ${row.dueDate}` : null]
    .filter(Boolean)
    .join(" / ")
    .slice(0, 255);
}

export async function uploadsFor(db: Db, row: Pick<MessageRow, "rfcMessageId" | "gmailMessageId">) {
  return db
    .select()
    .from(freeeUploads)
    .where(
      row.rfcMessageId
        ? or(eq(freeeUploads.gmailMessageId, row.gmailMessageId), eq(freeeUploads.rfcMessageId, row.rfcMessageId))
        : eq(freeeUploads.gmailMessageId, row.gmailMessageId),
    );
}

export type FreeeSendResult = { kind: "uploaded"; receiptId: string } | { kind: "already"; receiptId: string };

export async function sendAttachmentToFreee(
  deps: { db: Db; mail: MailApi; freee: FreeeApi },
  user: User,
  row: MessageRow,
  partId: string,
): Promise<FreeeSendResult> {
  const { db, mail, freee } = deps;
  const setting = await getSetting(db, "freee");
  if (!setting.refreshTokenEnc || !setting.companyId) throw new FreeeNotConnectedError();

  const parsed = parseMessage(await mail.getMessage(row.gmailMessageId));
  const att = parsed.attachments.find((a) => a.partId === partId);
  if (!att) throw new Error("添付ファイルが見つかりません");
  if (!FREEE_RECEIPT_TYPES.has(att.mimeType)) throw new Error("freee に送れるのは PDF と画像（JPEG・PNG・GIF）だけです");

  const key = uploadKey(row, att.filename);
  const existing = (await db.select().from(freeeUploads).where(eq(freeeUploads.dedupeKey, key)).limit(1))[0];
  if (existing) return { kind: "already", receiptId: existing.receiptId };

  const data = await mail.getAttachment(row.gmailMessageId, att.attachmentId);
  const { id } = await freee.uploadReceipt({
    companyId: setting.companyId,
    filename: att.filename,
    mimeType: att.mimeType,
    data,
    description: receiptDescription(row),
    issueDate: jstDateString(row.receivedAt),
  });
  await db
    .insert(freeeUploads)
    .values({
      dedupeKey: key,
      userId: user.id,
      gmailMessageId: row.gmailMessageId,
      rfcMessageId: row.rfcMessageId,
      filename: att.filename,
      receiptId: id,
    })
    .onConflictDoNothing();
  await mail.modifyMessage(row.gmailMessageId, [await new LabelResolver(mail).statusId("freee")], []);
  return { kind: "uploaded", receiptId: id };
}
