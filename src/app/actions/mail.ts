"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { contacts, drafts, messages, rules, type MessageRow, type User } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { BLOCK_RULE, folderLabelName, isFolder, STATUS_LABELS } from "@/lib/domain";
import { canSeeMessage } from "@/lib/access";
import { generateDraft, saveDraftText } from "@/lib/drafts";
import { LabelResolver } from "@/lib/labels";
import { buildMime, replySubject } from "@/lib/mail/mime";
import { parseMessage } from "@/lib/mail/parse";
import { hasPlaceholders } from "@/lib/placeholders";
import { processMessage } from "@/lib/pipeline";
import { draftDeps, mailFor, pipelineDeps } from "@/lib/services";
import { getSetting } from "@/lib/settings";
import { bodyHash } from "@/lib/crypto";
import { requireUser } from "@/lib/session";
import { safeBack } from "@/lib/queries";
import { errorResult, ownMessage, type ActionResult } from "./common";

/** フォルダを直す。「今後もこの送信者／ドメインは」を選べば学習ルールとして保存する（仕様書 4章） */
export async function moveFolder(formData: FormData): Promise<void> {
  const rowId = Number(formData.get("rowId"));
  const folder = String(formData.get("folder"));
  const remember = String(formData.get("remember") ?? "");
  if (!isFolder(folder)) throw new Error("フォルダが正しくありません");
  const { user, row } = await ownMessage(rowId);
  const db = await getDb();
  const mail = mailFor(user);
  const labels = new LabelResolver(mail);

  const remove: string[] = [];
  if (row.folder !== folder) {
    const old = await labels.existingId(folderLabelName(row.folder as never));
    if (old) remove.push(old);
  }
  const review = await labels.existingId(STATUS_LABELS.needsReview);
  if (review) remove.push(review);
  await mail.modifyMessage(row.gmailMessageId, [await labels.folderId(folder)], remove);
  await db
    .update(messages)
    .set({
      folder,
      category: folder === "personal" ? row.category : folder,
      secondaryFolders: row.secondaryFolders.filter((f) => f !== folder),
      needsReview: false,
      source: "manual",
    })
    .where(eq(messages.id, row.id));
  await audit(db, user.id, "folder_moved", row.gmailMessageId, { from: row.folder, to: folder });

  if (remember === "sender" || remember === "domain") {
    const pattern = remember === "sender" ? row.fromEmail : row.fromEmail.slice(row.fromEmail.indexOf("@") + 1);
    await db
      .insert(rules)
      .values({ kind: remember, pattern, folder, createdBy: user.id })
      .onConflictDoUpdate({ target: [rules.kind, rules.pattern], set: { folder } });
    await audit(db, user.id, "rule_created", pattern, { kind: remember, folder });
  }
  revalidatePath(`/m/${row.id}`);
}

export async function markReviewed(formData: FormData): Promise<void> {
  const { user, row } = await ownMessage(Number(formData.get("rowId")));
  const db = await getDb();
  const mail = mailFor(user);
  const review = await new LabelResolver(mail).existingId(STATUS_LABELS.needsReview);
  if (review) await mail.modifyMessage(row.gmailMessageId, [], [review]);
  await db.update(messages).set({ needsReview: false }).where(eq(messages.id, row.id));
  revalidatePath(`/m/${row.id}`);
}

export async function generateDraftAction(
  rowId: number,
  instruction: string | null,
  withSlots = false,
): Promise<ActionResult> {
  try {
    const { user, row } = await ownMessage(rowId);
    const db = await getDb();
    const r = await generateDraft(draftDeps(db, user), user, row.gmailThreadId, row.gmailMessageId, {
      generatedBy: "manual",
      instruction: instruction?.trim() || null,
      withSlots,
    });
    if (r.kind === "skipped") return { ok: false, error: r.reason };
    await audit(db, user.id, "draft_generated", row.gmailThreadId, { instruction, kind: r.kind });
    revalidatePath(`/m/${row.id}`);
    return { ok: true };
  } catch (err) {
    return errorResult(err);
  }
}

/** Claude を使わず、署名だけ入った空の返信下書きを作る（手で書く） */
export async function emptyReplyAction(rowId: number): Promise<ActionResult> {
  try {
    const { user, row } = await ownMessage(rowId);
    const db = await getDb();
    const mail = mailFor(user);
    const target = parseMessage(await mail.getMessage(row.gmailMessageId));
    const to = target.replyTo ?? target.from;
    if (!to) return { ok: false, error: "返信先のアドレスが見つかりません" };
    const sigs = await getSetting(db, "signatures");
    const text = `\n\n${row.language === "ja" ? sigs.ja : sigs.en}`;
    const raw = buildMime({
      to: [to],
      subject: replySubject(target.subject),
      text,
      inReplyTo: target.messageIdHeader,
      references: target.references,
    });
    const ref = await mail.createDraft(raw, row.gmailThreadId);
    await db.insert(drafts).values({
      userId: user.id,
      gmailThreadId: row.gmailThreadId,
      replyToMessageId: row.gmailMessageId,
      gmailDraftId: ref.draftId,
      bodyHash: bodyHash(text),
      notes: "手で書く下書き",
      generatedBy: "manual",
    });
    revalidatePath(`/m/${row.id}`);
    return { ok: true };
  } catch (err) {
    return errorResult(err);
  }
}

async function ownDraft(draftRowId: number) {
  const user = await requireUser();
  const db = await getDb();
  const d = (
    await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftRowId), eq(drafts.userId, user.id)))
      .limit(1)
  )[0];
  if (!d) throw new Error("下書きが見つかりません");
  return { user, db, d };
}

export async function saveDraftAction(draftRowId: number, text: string): Promise<ActionResult> {
  try {
    const { user, db, d } = await ownDraft(draftRowId);
    await saveDraftText(mailFor(user), d.gmailDraftId, d.gmailThreadId, text);
    await audit(db, user.id, "draft_saved", d.gmailThreadId);
    return { ok: true };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * 送信の準備：本文を Gmail の下書きに保存し、【要確認】が残っていないことを確かめる。
 * 送信そのものはブラウザが本人のトークンで行う（サーバーは送信しない）。
 */
export async function prepareSendAction(
  draftRowId: number,
  text: string,
): Promise<ActionResult<{ gmailDraftId: string; email: string }>> {
  try {
    if (hasPlaceholders(text)) return { ok: false, error: "【要確認】が残っています。全て埋めてから送信してください" };
    const { user, d } = await ownDraft(draftRowId);
    await saveDraftText(mailFor(user), d.gmailDraftId, d.gmailThreadId, text);
    return { ok: true, data: { gmailDraftId: d.gmailDraftId, email: user.email } };
  } catch (err) {
    return errorResult(err);
  }
}

export async function markSentAction(draftRowId: number): Promise<ActionResult> {
  try {
    const { user, db, d } = await ownDraft(draftRowId);
    await db.update(drafts).set({ status: "sent" }).where(eq(drafts.id, d.id));
    // 同じスレッドの他の案は役目を終えたので閉じる
    await db
      .update(drafts)
      .set({ status: "discarded" })
      .where(and(eq(drafts.userId, user.id), eq(drafts.gmailThreadId, d.gmailThreadId), eq(drafts.status, "ready")));
    await db
      .update(messages)
      .set({ status: "replied", needsReply: false })
      .where(
        and(
          eq(messages.userId, user.id),
          eq(messages.gmailThreadId, d.gmailThreadId),
          inArray(messages.status, ["new", "draft_ready"]),
        ),
      );
    const mail = mailFor(user);
    const labels = new LabelResolver(mail);
    const remove = (
      await Promise.all([labels.existingId(STATUS_LABELS.needsReply), labels.existingId(STATUS_LABELS.draftReady)])
    ).filter((x): x is string => Boolean(x));
    await mail.modifyThread(d.gmailThreadId, [await labels.statusId("done")], remove);
    await audit(db, user.id, "mail_sent", d.gmailThreadId, { draftId: d.gmailDraftId });
    return { ok: true };
  } catch (err) {
    return errorResult(err);
  }
}

export type RemoveKind = "archive" | "spam" | "trash";

function isRemoveKind(v: unknown): v is RemoveKind {
  return v === "archive" || v === "spam" || v === "trash";
}

/**
 * アーカイブ・迷惑メール・ゴミ箱。Gmail 側を先に変え、成功した行だけアプリの一覧から外す。
 * ゴミ箱と迷惑メールは Gmail で30日間は元に戻せる。
 */
async function removeRows(user: User, rows: MessageRow[], kind: RemoveKind): Promise<number> {
  const db = await getDb();
  const mail = mailFor(user);
  const done = kind === "archive" ? await new LabelResolver(mail).statusId("done") : null;
  const ok: number[] = [];
  for (const row of rows) {
    try {
      if (kind === "spam") await mail.modifyMessage(row.gmailMessageId, ["SPAM"], ["INBOX", "UNREAD"]);
      else if (kind === "trash") await mail.trashMessage(row.gmailMessageId);
      else await mail.modifyMessage(row.gmailMessageId, [done!], ["INBOX"]);
      ok.push(row.id);
    } catch (err) {
      if (rows.length === 1) throw err;
      console.error(`${kind} failed`, row.gmailMessageId, err);
    }
  }
  if (!ok.length) return 0;
  await db
    .update(messages)
    .set({ status: kind === "archive" ? "done" : "skipped", needsReply: false, unread: false })
    .where(inArray(messages.id, ok));
  const action = kind === "spam" ? "spam" : kind === "trash" ? "trashed" : "archived";
  for (const row of rows.filter((r) => ok.includes(r.id))) await audit(db, user.id, action, row.gmailMessageId);
  return ok.length;
}

/** 迷惑メールにした送信者を、今後は届いた時点で迷惑メールへ移すルールにする。自社のアドレスは対象外 */
async function blockSenders(user: User, rows: MessageRow[]): Promise<number> {
  const db = await getDb();
  const own = user.email.slice(user.email.indexOf("@") + 1).toLowerCase();
  const senders = [...new Set(rows.map((r) => r.fromEmail.toLowerCase()))].filter(
    (e) => e.includes("@") && e.slice(e.indexOf("@") + 1) !== own,
  );
  for (const pattern of senders) {
    await db
      .insert(rules)
      .values({ kind: "sender", pattern, folder: BLOCK_RULE, createdBy: user.id })
      .onConflictDoUpdate({ target: [rules.kind, rules.pattern], set: { folder: BLOCK_RULE } });
    await audit(db, user.id, "rule_created", pattern, { kind: "sender", folder: BLOCK_RULE });
  }
  return senders.length;
}

export async function archiveAction(formData: FormData): Promise<void> {
  const { user, row } = await ownMessage(Number(formData.get("rowId")));
  const kind = String(formData.get("kind"));
  if (!isRemoveKind(kind)) throw new Error("操作が正しくありません");
  await removeRows(user, [row], kind);
  if (kind === "spam" && formData.get("block")) await blockSenders(user, [row]);
  revalidatePath("/", "layout");
  redirect(safeBack(String(formData.get("back") ?? "")));
}

async function ownRows(user: User, ids: number[]): Promise<MessageRow[]> {
  if (!ids.length) return [];
  const db = await getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, user.id), inArray(messages.id, ids)));
  return rows.filter((r) => canSeeMessage(user, r));
}

function withNotice(back: string, notice: string): string {
  const url = new URL(back, "http://x");
  url.searchParams.set("notice", notice);
  return `${url.pathname}${url.search}`;
}

const REMOVE_WORDS: Record<RemoveKind, string> = { archive: "アーカイブ", spam: "迷惑メール", trash: "ゴミ箱" };

/**
 * 一覧でチェックしたメールをまとめて迷惑メール／ゴミ箱／アーカイブにする。
 * 行の × ボタン（1通だけ）もここに来る。
 */
export async function bulkRemoveAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  // 行のボタンは "spam:123" のように操作と行をまとめて送る
  const only = String(formData.get("only") ?? "");
  const [kind, ...picked] = only ? only.split(":") : [String(formData.get("kind")), ...formData.getAll("sel").map(String)];
  if (!isRemoveKind(kind)) throw new Error("操作が正しくありません");
  const ids = picked
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 200);
  const back = safeBack(String(formData.get("back") ?? ""));
  const rows = await ownRows(user, ids);
  if (!rows.length) redirect(back);
  const n = await removeRows(user, rows, kind);
  const blocked = kind === "spam" && formData.get("block") ? await blockSenders(user, rows) : 0;
  revalidatePath("/", "layout");
  const failed = rows.length - n;
  redirect(
    withNotice(
      back,
      `${n}件を${REMOVE_WORDS[kind]}にしました` +
        (blocked ? `（${blocked}件の送信者は今後も自動で迷惑メールへ）` : "") +
        (failed ? `。${failed}件は失敗しました` : ""),
    ),
  );
}

export async function saveContactAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const email = String(formData.get("email")).toLowerCase();
  const values = {
    notes: String(formData.get("notes") ?? ""),
    organization: String(formData.get("organization") ?? "") || null,
    relationship: String(formData.get("relationship") ?? "") || null,
  };
  await db
    .insert(contacts)
    .values({ email, ...values })
    .onConflictDoUpdate({ target: contacts.email, set: { ...values, updatedAt: new Date() } });
  await audit(db, user.id, "settings_changed", `contact:${email}`);
  const back = String(formData.get("back") ?? "");
  if (back.startsWith("/")) revalidatePath(back.split("?")[0]);
}

/** 検索で見つけた、まだ分類していないメールを取り込む */
export async function importMessageAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const id = String(formData.get("gmailMessageId"));
  await processMessage(pipelineDeps(db, user), user, id);
  const row = (
    await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.userId, user.id), eq(messages.gmailMessageId, id)))
      .limit(1)
  )[0];
  if (row) redirect(`/m/${row.id}`);
  redirect("/search");
}

/**
 * 開いたメールを既読にする。アプリの一覧・左の件数と、Gmail 側の未読の両方を更新する。
 * Gmail への反映に失敗しても、アプリ側は既読にする（次の同期で揃う）。
 */
export async function markReadAction(rowId: number): Promise<void> {
  const { user, row } = await ownMessage(rowId);
  if (!row.unread) return;
  const db = await getDb();
  await db.update(messages).set({ unread: false }).where(eq(messages.id, row.id));
  try {
    await mailFor(user).modifyMessage(row.gmailMessageId, [], ["UNREAD"]);
  } catch (err) {
    console.error("mark read in Gmail failed", row.gmailMessageId, err);
  }
  revalidatePath("/", "layout");
}
