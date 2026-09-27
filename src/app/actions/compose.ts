"use server";

import { getDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { buildMime, type MimeAttachment } from "@/lib/mail/mime";
import { parseAddressList, parseMessage } from "@/lib/mail/parse";
import { hasPlaceholders } from "@/lib/placeholders";
import { mailFor } from "@/lib/services";
import { requireUser } from "@/lib/session";
import { errorResult, ownMessage, type ActionResult } from "./common";

export interface ComposeInput {
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  forwardRowId: number | null;
  includeAttachments: boolean;
  /** 送らずに Gmail の下書きとして保存するだけ（【要確認】が残っていてもよい） */
  saveOnly?: boolean;
}

/** 新規作成・転送の下書きを Gmail に作る。送信はブラウザが行う */
export async function createComposeDraft(
  input: ComposeInput,
): Promise<ActionResult<{ gmailDraftId: string; email: string }>> {
  try {
    const user = await requireUser();
    const to = parseAddressList(input.to);
    if (!to.length && !input.saveOnly) return { ok: false, error: "宛先を入れてください" };
    if (hasPlaceholders(input.text) && !input.saveOnly) return { ok: false, error: "【要確認】が残っています" };
    const mail = mailFor(user);
    const sendAs = await mail.sendAsAddresses();
    const from = sendAs.find((a) => a.email === input.from.toLowerCase()) ?? null;

    const attachments: MimeAttachment[] = [];
    let threadId: string | null = null;
    if (input.forwardRowId) {
      const { row } = await ownMessage(input.forwardRowId);
      if (input.includeAttachments) {
        const original = parseMessage(await mail.getMessage(row.gmailMessageId));
        for (const a of original.attachments) {
          attachments.push({
            filename: a.filename,
            mimeType: a.mimeType,
            data: await mail.getAttachment(row.gmailMessageId, a.attachmentId),
          });
        }
      }
      threadId = null; // 転送は新しいスレッドにする
    }
    const raw = buildMime({
      from,
      to,
      cc: parseAddressList(input.cc),
      subject: input.subject,
      text: input.text,
      attachments,
    });
    const ref = await mail.createDraft(raw, threadId);
    return { ok: true, data: { gmailDraftId: ref.draftId, email: user.email } };
  } catch (err) {
    return errorResult(err);
  }
}

export async function recordComposeSent(gmailDraftId: string, subject: string): Promise<void> {
  // 送信はブラウザが行ったので、ここでは記録だけ残す
  const user = await requireUser();
  await audit(await getDb(), user.id, "mail_sent", gmailDraftId, { subject, compose: true });
}
