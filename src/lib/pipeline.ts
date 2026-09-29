import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db";
import { addressMap, contacts, dateCandidates, messages, rules, type User } from "./db/schema";
import { classifyByHeaders, matchBlockRule, type SenderRule } from "./classify/stage1";
import { mergeClassification, type MergedClassification } from "./classify/merge";
import type { Classifier, ContentClassification } from "./classify/types";
import { DATE_KINDS, STATUS_LABELS, isFolder, type Folder } from "./domain";
import { MessageNotFoundError, type MailApi } from "./google/mail-api";
import { LabelResolver } from "./labels";
import { listIdToAddress, parseMessage, stripQuoted, type ParsedMessage } from "./mail/parse";
import { enqueue } from "./jobs";
import { canSeeMessage } from "./access";
import { getSetting } from "./settings";
import { isRetryableApiError } from "./claude/client";

export interface PipelineDeps {
  db: Db;
  mail: MailApi;
  classifier: Classifier;
}

export type ProcessResult =
  | { kind: "skipped"; reason: string }
  | { kind: "reply_recorded"; threadId: string }
  | { kind: "classified"; messageRowId: number; merged: MergedClassification; draftQueued: boolean };

const SKIP_LABELS = ["SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS"];

async function loadRules(db: Db): Promise<{ senderRules: SenderRule[]; addresses: Awaited<ReturnType<typeof loadAddresses>> }> {
  const r = await db.select().from(rules);
  return {
    senderRules: r.map((x) => ({ kind: x.kind as SenderRule["kind"], pattern: x.pattern, folder: x.folder })),
    addresses: await loadAddresses(db),
  };
}

async function loadAddresses(db: Db) {
  return db.select().from(addressMap);
}

/** 同じメール（Message-ID）を別の人の受信箱で既に分類していれば、その結果を使い回す */
async function reuseClassification(db: Db, rfcMessageId: string | null): Promise<ContentClassification | null> {
  if (!rfcMessageId) return null;
  const rows = await db.select().from(messages).where(eq(messages.rfcMessageId, rfcMessageId)).limit(1);
  const row = rows[0];
  // 分類に失敗して要確認になった行や、自信の値が無い行は使い回さない（誤りが広がるため）
  if (!row || !row.category || row.needsReview || row.confidence === null) return null;
  if (row.source === "sender_rule" || row.source === "domain_rule" || row.source === "manual") return null;
  const dates = await db
    .select()
    .from(dateCandidates)
    .where(and(eq(dateCandidates.userId, row.userId), eq(dateCandidates.gmailMessageId, row.gmailMessageId)));
  return {
    category: row.category as ContentClassification["category"],
    needs_reply: row.needsReply,
    urgency: row.urgency as ContentClassification["urgency"],
    language: row.language as ContentClassification["language"],
    dates: dates.map((d) => ({
      kind: d.kind as ContentClassification["dates"][number]["kind"],
      title: d.title,
      start: d.start,
      end: d.end,
      all_day: d.allDay,
      note: d.note,
    })),
    amount: row.amount === null ? null : { value: row.amount, currency: row.currency ?? "JPY" },
    due_date: row.dueDate,
    summary: row.summary,
    accepts_proposed_time: row.suggestConfirm,
    confidence: row.confidence,
  };
}

/** 自分たちが返信したスレッドの「要返信」を外し、対応済にする */
export async function recordReply(deps: PipelineDeps, user: User, threadId: string): Promise<void> {
  const { db, mail } = deps;
  const pending = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, user.id), eq(messages.gmailThreadId, threadId)));
  if (!pending.length) return;
  await db
    .update(messages)
    .set({ status: "replied", needsReply: false })
    .where(and(eq(messages.userId, user.id), eq(messages.gmailThreadId, threadId), inArray(messages.status, ["new", "draft_ready"])));
  const labels = new LabelResolver(mail);
  const remove = (
    await Promise.all([labels.existingId(STATUS_LABELS.needsReply), labels.existingId(STATUS_LABELS.draftReady)])
  ).filter((x): x is string => Boolean(x));
  await mail.modifyThread(threadId, [await labels.statusId("done")], remove);
}

export interface ProcessOptions {
  /** 過去メールの取り込みでは下書きを自動で作らない */
  autoDraft?: boolean;
}

export async function processMessage(
  deps: PipelineDeps,
  user: User,
  gmailMessageId: string,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const { db, mail, classifier } = deps;

  const existing = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.userId, user.id), eq(messages.gmailMessageId, gmailMessageId)))
    .limit(1);
  if (existing.length) return { kind: "skipped", reason: "already_processed" };

  let raw;
  try {
    raw = await mail.getMessage(gmailMessageId);
  } catch (err) {
    if (err instanceof MessageNotFoundError) return { kind: "skipped", reason: "not_found" };
    throw err;
  }
  const msg = parseMessage(raw);

  if (msg.labelIds.includes("SENT") || msg.from?.email === user.email) {
    await recordReply(deps, user, msg.threadId);
    return { kind: "reply_recorded", threadId: msg.threadId };
  }
  const skipLabel = msg.labelIds.find((l) => SKIP_LABELS.includes(l));
  if (skipLabel) return { kind: "skipped", reason: skipLabel };
  if (!msg.from) return { kind: "skipped", reason: "no_sender" };
  const from = msg.from;

  const { senderRules, addresses } = await loadRules(db);
  // 「今後も迷惑メールへ」にした送信者：分類せず（Claude も使わず）迷惑メールへ移す
  if (matchBlockRule(from.email, senderRules)) {
    await mail.modifyMessage(gmailMessageId, ["SPAM"], ["INBOX", "UNREAD"]);
    return { kind: "skipped", reason: "blocked" };
  }
  const stage1 = classifyByHeaders(msg, senderRules, addresses);

  let content: ContentClassification | null = null;
  const ruleSaysInfo = (stage1.source === "sender_rule" || stage1.source === "domain_rule") && stage1.folder === "info";
  // 一斉配信が個人・総合窓口アドレスに届いたときは、Claude を使わずニュースレターへ。
  // 実際の受信箱の約8割がこれに当たる。用途別アドレス宛てと送信者ルールがあるものは対象外
  const bulkToPersonal =
    msg.bulk &&
    !isOwnGroupMail(msg, addresses) &&
    !looksLikeBusiness(msg) &&
    (stage1.source === "none" || (stage1.source === "address" && stage1.contentDecides));
  if (!ruleSaysInfo && !bulkToPersonal) {
    content = await reuseClassification(db, msg.messageIdHeader);
    if (!content) {
      try {
        content = await classifier.classify({
          from: msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email,
          to: [...msg.to, ...msg.cc].map((a) => a.email),
          subject: msg.subject,
          body: stripQuoted(msg.text) || msg.text,
          attachmentNames: msg.attachments.map((a) => a.filename),
          receivedAt: msg.date,
          stage1Folder: stage1.folder,
        });
      } catch (err) {
        // 混雑（429）や一時的な障害はジョブごと後でやり直す。それ以外は要確認として置く
        if (isRetryableApiError(err)) throw err;
        console.error("classification failed", gmailMessageId, err);
        content = null;
      }
    }
  }

  const merged: MergedClassification = bulkToPersonal
    ? { folder: "info", category: "info", secondaryFolders: stage1.secondaryFolders, source: "content", needsReview: false }
    : mergeClassification(stage1, content);
  // 返信が要ると判定されても、このメールより後に自分たちが返信していれば対応済み（過去メールの取り込みで多い）
  let needsReply = content?.needs_reply ?? false;
  let answered = false;
  if (needsReply) {
    answered = await answeredLater(mail, user, msg);
    if (answered) needsReply = false;
  }

  // 相手が仮予定を承諾したと読めるか（同じスレッドに「仮」の予定があるときだけ）
  let suggestConfirm = false;
  if (content?.accepts_proposed_time) {
    const tentative = await db
      .select({ id: dateCandidates.id })
      .from(dateCandidates)
      .where(
        and(
          eq(dateCandidates.userId, user.id),
          eq(dateCandidates.gmailThreadId, msg.threadId),
          eq(dateCandidates.status, "tentative"),
        ),
      )
      .limit(1);
    suggestConfirm = tentative.length > 0;
  }

  // Gmail 側（ラベル）を先に付ける。途中で失敗してもジョブの再実行で最初からやり直せるよう、
  // DB への記録は最後に1つのトランザクションで行う
  await applyLabels(mail, msg, merged, needsReply);

  const messageRowId = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const inserted = await tx
    .insert(messages)
    .values({
      userId: user.id,
      gmailMessageId: msg.id,
      gmailThreadId: msg.threadId,
      rfcMessageId: msg.messageIdHeader,
      fromEmail: from.email,
      fromName: from.name,
      subject: msg.subject,
      toAddresses: [...msg.to, ...msg.cc].map((a) => a.email),
      folder: merged.folder,
      secondaryFolders: merged.secondaryFolders,
      category: merged.category,
      source: merged.source,
      needsReply,
      urgency: content?.urgency ?? "normal",
      language: content?.language ?? "ja",
      summary: content?.summary ?? msg.subject,
      amount: content?.amount?.value ?? null,
      currency: content?.amount?.currency ?? null,
      dueDate: content?.due_date ?? null,
      confidence: content?.confidence ?? null,
      needsReview: merged.needsReview,
      suggestConfirm,
      status: needsReply ? "new" : answered ? "replied" : "done",
      unread: msg.labelIds.includes("UNREAD"),
      hasAttachments: msg.attachments.length > 0,
      receivedAt: msg.date,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
    if (!inserted.length) return null;
    await saveDateCandidates(tx, user, msg, content);
    // ニュースレターの送り主は連絡先に入れない（夜間の要約の対象を業務の相手に絞る）
    if (merged.folder !== "info") await upsertContact(tx, msg);
    return inserted[0].id;
  });
  if (messageRowId === null) return { kind: "skipped", reason: "already_processed" };

  let draftQueued = false;
  // 見られないフォルダのメールには、その人の受信箱で下書きを作らない
  const visible = canSeeMessage(user, { folder: merged.folder, secondaryFolders: merged.secondaryFolders });
  if (needsReply && visible && opts.autoDraft !== false) {
    const autoDraft = await getSetting(db, "autoDraft");
    const key: Folder = merged.category ?? merged.folder;
    if (autoDraft[key] ?? true) {
      // グループ宛てで複数人に届いたメールは、最初に処理した1人の受信箱にだけ自動で下書きを作る
      const dedupe = msg.messageIdHeader ? `draft:rfc:${msg.messageIdHeader}` : `draft:${user.id}:${msg.id}`;
      draftQueued = await enqueue(
        db,
        "generate_draft",
        { userId: user.id, threadId: msg.threadId, messageId: msg.id, generatedBy: "auto" },
        dedupe,
      );
    }
  }

  // 通知：既定は「至急の要返信」だけ。過去メールの取り込みでは鳴らさない
  if (needsReply && visible && opts.autoDraft !== false) {
    const notify = await getSetting(db, "notify");
    const urgent = content?.urgency === "high";
    if (notify.mode === "replies" || (notify.mode === "urgent" && urgent)) {
      await enqueue(
        db,
        "notify",
        {
          userId: user.id,
          title: `${urgent ? "【至急】" : ""}${msg.from.name || msg.from.email}`,
          body: content?.summary || msg.subject,
          url: `/m/${messageRowId}`,
          tag: `msg-${messageRowId}`,
        },
        `notify:${user.id}:${msg.id}`,
      );
    }
  }

  return { kind: "classified", messageRowId, merged, draftQueued };
}

async function applyLabels(
  mail: MailApi,
  msg: ParsedMessage,
  merged: MergedClassification,
  needsReply: boolean,
): Promise<void> {
  const labels = new LabelResolver(mail);
  const add = [await labels.folderId(merged.folder)];
  for (const f of merged.secondaryFolders) if (isFolder(f)) add.push(await labels.folderId(f));
  if (needsReply) add.push(await labels.statusId("needsReply"));
  if (merged.needsReview) add.push(await labels.statusId("needsReview"));
  await mail.modifyMessage(msg.id, add, []);
}

async function saveDateCandidates(
  db: Db,
  user: User,
  msg: ParsedMessage,
  content: ContentClassification | null,
): Promise<void> {
  if (!content) return;
  const rows = content.dates
    .filter((d) => (DATE_KINDS as readonly string[]).includes(d.kind) && d.start)
    .map((d) => ({
      userId: user.id,
      gmailMessageId: msg.id,
      gmailThreadId: msg.threadId,
      kind: d.kind,
      title: d.title,
      start: d.start,
      end: d.end,
      allDay: d.all_day,
      note: d.note,
    }));
  // 請求書に支払期限があれば、支払期日の候補を必ず作る（仕様書 6章）
  if (content.due_date && !rows.some((r) => r.kind === "payment_due")) {
    const amount = content.amount ? ` ${content.amount.value.toLocaleString("ja-JP")} ${content.amount.currency}` : "";
    rows.push({
      userId: user.id,
      gmailMessageId: msg.id,
      gmailThreadId: msg.threadId,
      kind: "payment_due",
      title: `支払期日: ${msg.from?.name ?? msg.from?.email ?? ""}${amount}`,
      start: content.due_date,
      end: null,
      allDay: true,
      note: content.summary,
    });
  }
  if (rows.length) await db.insert(dateCandidates).values(rows);
}

async function upsertContact(db: Db, msg: ParsedMessage): Promise<void> {
  if (!msg.from) return;
  // 過去メールは新しい順に処理されるので、最終受信日時は大きい方を残す
  await db
    .insert(contacts)
    .values({ email: msg.from.email, name: msg.from.name, lastMessageAt: msg.date })
    .onConflictDoUpdate({
      target: contacts.email,
      set: {
        lastMessageAt: sql`greatest(${contacts.lastMessageAt}, excluded.last_message_at)`,
        name: sql`coalesce(${contacts.name}, excluded.name)`,
        updatedAt: new Date(),
      },
    });
}

/** 自分たちの Google グループ（info@ など）経由のメール。グループが List-Unsubscribe を付けるので一斉配信と見分ける */
function isOwnGroupMail(msg: ParsedMessage, addresses: Array<{ address: string }>): boolean {
  const group = listIdToAddress(msg.listId);
  return Boolean(group && addresses.some((a) => a.address.toLowerCase() === group));
}

/** 一斉配信の形でも、請求書・注文・予約・問合せなどは Claude で分類する */
const BUSINESS_HINT =
  /請求|領収|支払|振込|入金|納品|見積|注文|発注|予約|問い?合わ?せ|お問合せ|取材|応募|invoice|receipt|payment|billing|order|booking|reservation|inquiry|enquiry|quote|quotation/i;

function looksLikeBusiness(msg: ParsedMessage): boolean {
  if (BUSINESS_HINT.test(msg.subject)) return true;
  return msg.attachments.some((a) => a.mimeType === "application/pdf");
}

/** このメールより後に、自分たちが同じスレッドで返信しているか */
async function answeredLater(mail: MailApi, user: User, msg: ParsedMessage): Promise<boolean> {
  try {
    const thread = await mail.getThread(msg.threadId);
    return (thread.messages ?? []).some((m) => {
      const labels = m.labelIds ?? [];
      if (labels.includes("DRAFT")) return false;
      const ours = labels.includes("SENT");
      return ours && Number(m.internalDate ?? 0) > msg.date.getTime();
    });
  } catch {
    return false;
  }
}
