import { and, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "./db";
import { addressMap, contacts, dateCandidates, drafts, messages, rules, type User } from "./db/schema";
import { classifyByHeaders, matchBlockRule, type SenderRule } from "./classify/stage1";
import { mergeClassification, type MergedClassification } from "./classify/merge";
import type { Classifier, ContentClassification } from "./classify/types";
import { DATE_KINDS, STATUS_LABELS, isFolder, type Folder } from "./domain";
import { MessageNotFoundError, type MailApi } from "./google/mail-api";
import { LabelResolver } from "./labels";
import { header, listIdToAddress, parseMessage, stripQuoted, type ParsedMessage } from "./mail/parse";
import { enqueue } from "./jobs";
import { canSeeMessage } from "./access";
import { getSetting, recordClaudeResult } from "./settings";
import { describeClaudeError, isRetryableApiError } from "./claude/client";

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
  const rows = await db.select().from(messages).where(eq(messages.rfcMessageId, rfcMessageId));
  // 分類に失敗して要確認になった行や、自信の値が無い行は使い回さない（誤りが広がるため）。
  // アーカイブ・迷惑メール・ゴミ箱にした行は「要返信」が消えていて元の判定が分からないので使わない
  const row = rows.find(
    (r) =>
      r.category &&
      !r.needsReview &&
      r.confidence !== null &&
      !["sender_rule", "domain_rule", "manual"].includes(r.source) &&
      !["archived", "skipped"].includes(r.status),
  );
  if (!row) return null;
  const dates = await db
    .select()
    .from(dateCandidates)
    .where(and(eq(dateCandidates.userId, row.userId), eq(dateCandidates.gmailMessageId, row.gmailMessageId)));
  return {
    category: row.category as ContentClassification["category"],
    // 返信済みの行は「要返信」を外してあるが、元の判定は要返信（返信済みかどうかは processMessage で別に見る）
    needs_reply: row.needsReply || row.status === "replied",
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
    confidence: row.confidence ?? 0,
  };
}

/**
 * 自分たちが返信したスレッドの「要返信」を外し、対応済にする。
 * sentAt より後に届いたメール（返信の後に相手から来た新しいメール）は対象にしない。
 * 過去メールの取り込みや再試行では、新しいメールが先に処理されることがあるため。
 * グループ宛てで他の人の受信箱にも届いている同じメールも、あわせて対応済にする。
 */
export async function recordReply(
  deps: PipelineDeps,
  user: User,
  threadId: string,
  sentAt?: Date,
  opts: { closeColleagues?: boolean } = {},
): Promise<void> {
  const { db, mail } = deps;
  const conds = [
    eq(messages.userId, user.id),
    eq(messages.gmailThreadId, threadId),
    inArray(messages.status, ["new", "draft_ready"]),
  ];
  if (sentAt) conds.push(lte(messages.receivedAt, sentAt));
  const updated = await db
    .update(messages)
    .set({ status: "replied", needsReply: false })
    .where(and(...conds))
    .returning({ gmailMessageId: messages.gmailMessageId });
  // 社内の人だけに宛てた返信（「〇〇さん、対応お願いします」など）では、同僚の受信箱のメールは閉じない
  if (opts.closeColleagues !== false) await closeForColleagues(db, user, threadId, sentAt);
  if (!updated.length) return;
  // 状態ラベルはメールごとに付けているので、外すのも対象のメールだけ（後から届いたメールの「要返信」は残す）
  await markRepliedLabels(mail, updated.map((u) => u.gmailMessageId));
}

/** 対応済のラベルを付け、要返信・下書きありを外す。Gmail で消されたメールは飛ばす */
export async function markRepliedLabels(mail: MailApi, gmailMessageIds: string[]): Promise<void> {
  if (!gmailMessageIds.length) return;
  const labels = new LabelResolver(mail);
  const remove = (
    await Promise.all([labels.existingId(STATUS_LABELS.needsReply), labels.existingId(STATUS_LABELS.draftReady)])
  ).filter((x): x is string => Boolean(x));
  const done = await labels.statusId("done");
  for (const id of gmailMessageIds) {
    await mail.modifyMessage(id, [done], remove).catch((err) => {
      if (!(err instanceof MessageNotFoundError) && (err as { code?: number }).code !== 404) throw err;
    });
  }
}

/**
 * グループ宛てのメールは同じものが複数人の受信箱に届く（Message-ID が同じで、user_id が違う行）。
 * 誰か1人が返信したら、他の人の受信箱の同じメールも対応済にする（2人目に「要返信」が残らないように）。
 * 他の人の Gmail のラベルはその人の Gmail でしか変えられないので、ジョブに積んで後で揃える。
 */
export async function closeForColleagues(db: Db, user: User, threadId: string, sentAt?: Date): Promise<number> {
  const conds = [
    eq(messages.userId, user.id),
    eq(messages.gmailThreadId, threadId),
    isNotNull(messages.rfcMessageId),
  ];
  if (sentAt) conds.push(lte(messages.receivedAt, sentAt));
  const replied = await db.select({ rfc: messages.rfcMessageId }).from(messages).where(and(...conds));
  const rfcIds = [...new Set(replied.map((r) => r.rfc!))];
  if (!rfcIds.length) return 0;
  const closed = await db
    .update(messages)
    .set({ status: "replied", needsReply: false })
    .where(
      and(
        ne(messages.userId, user.id),
        inArray(messages.rfcMessageId, rfcIds),
        inArray(messages.status, ["new", "draft_ready"]),
      ),
    )
    .returning({ userId: messages.userId, gmailMessageId: messages.gmailMessageId });
  for (const c of closed) {
    await enqueue(
      db,
      "mark_replied",
      { userId: c.userId, messageId: c.gmailMessageId },
      `replied:${c.userId}:${c.gmailMessageId}`,
    );
  }
  // 閉じたメールへの返信下書き（自動の下書きは最初に処理した1人に作る）も閉じる。
  // 残すとその人のメール画面に出たままになり、同じお客様に二重に返信してしまうため。Gmail の下書き自体は消さない
  const byUser = new Map<number, string[]>();
  for (const c of closed) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c.gmailMessageId]);
  for (const [userId, ids] of byUser) {
    await db
      .update(drafts)
      .set({ status: "discarded" })
      .where(and(eq(drafts.userId, userId), inArray(drafts.replyToMessageId, ids), eq(drafts.status, "ready")));
  }
  return closed.length;
}

/** 同じメール（Message-ID）を、他の人が既に返信しているか（グループ宛てで同僚が先に返信した） */
async function repliedByColleague(db: Db, user: User, rfcMessageId: string | null): Promise<boolean> {
  if (!rfcMessageId) return false;
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.rfcMessageId, rfcMessageId), ne(messages.userId, user.id), eq(messages.status, "replied")))
    .limit(1);
  return rows.length > 0;
}

/** 転送（Fwd: / FW: / 転送:）。Gmail では転送したメールも同じスレッドに入るが、相手への返信ではない */
const FORWARD_SUBJECT = /^\s*(fwd?|転送)\s*[:：]/i;

export interface ProcessOptions {
  /** 過去メールの取り込みでは下書きを自動で作らない */
  autoDraft?: boolean;
  /** 分類し直す前の状態。返信済み・下書きありは、分類し直しても戻さない */
  keepStatus?: "replied" | "draft_ready";
  /**
   * Claude の混雑・一時的な障害でも、ジョブをやり直さずに「要確認」で取り込む（何度かやり直した後）。
   * 混雑が何時間も続いてもメールが一覧に出るように。直った後は「分類し直す」で分類できる
   */
  fallbackOnBusy?: boolean;
}

export async function processMessage(
  deps: PipelineDeps,
  user: User,
  gmailMessageId: string,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const { db, mail, classifier } = deps;

  const existing = await db
    .select({ id: messages.id, status: messages.status })
    .from(messages)
    .where(and(eq(messages.userId, user.id), eq(messages.gmailMessageId, gmailMessageId)))
    .limit(1);
  // アプリで迷惑メール・ゴミ箱にした行（skipped）は、Gmail で戻されたときだけ処理し直す
  if (existing.length && existing[0].status !== "skipped") return { kind: "skipped", reason: "already_processed" };

  let raw;
  try {
    raw = await mail.getMessage(gmailMessageId);
  } catch (err) {
    if (err instanceof MessageNotFoundError) return { kind: "skipped", reason: existing.length ? "already_processed" : "not_found" };
    throw err;
  }
  const msg = parseMessage(raw);
  // Gmail の迷惑メール・ゴミ箱から戻された：届いたメールとして分類し直す。古い行は最後の記録と同じ
  // トランザクションで消す（先に消すと、分類の失敗でやり直したときに「戻されたメール」と分からなくなり、
  // 迷惑メールに指定した送信者のメールを迷惑メールへ戻してしまう）
  const restoredRowId = existing.length ? existing[0].id : null;
  if (restoredRowId !== null && msg.labelIds.some((l) => l === "SPAM" || l === "TRASH")) {
    return { kind: "skipped", reason: "already_processed" };
  }
  // 下書き（自分の下書きは From が自分なので、返信と取り違えないよう先に除く）
  if (msg.labelIds.includes("DRAFT")) return { kind: "skipped", reason: "DRAFT" };

  if (msg.labelIds.includes("SENT") || msg.from?.email === user.email) {
    // 社内への転送などは返信ではないので、スレッドの「要返信」はそのままにする
    if (FORWARD_SUBJECT.test(msg.subject)) return { kind: "skipped", reason: "own_forward" };
    const ownDomain = user.email.slice(user.email.indexOf("@") + 1).toLowerCase();
    const external = [...msg.to, ...msg.cc].some((a) => a.email.slice(a.email.indexOf("@") + 1).toLowerCase() !== ownDomain);
    await recordReply(deps, user, msg.threadId, msg.date, { closeColleagues: external });
    return { kind: "reply_recorded", threadId: msg.threadId };
  }
  const skipLabel = msg.labelIds.find((l) => SKIP_LABELS.includes(l));
  if (skipLabel) return { kind: "skipped", reason: skipLabel };
  if (!msg.from) return { kind: "skipped", reason: "no_sender" };
  const from = msg.from;

  const { senderRules, addresses } = await loadRules(db);
  // 「今後も迷惑メールへ」にした送信者：分類せず（Claude も使わず）迷惑メールへ移す
  // ただし人が Gmail の迷惑メール・ゴミ箱から戻したメールは、本人の判断を優先して迷惑メールへ戻さない
  if (restoredRowId === null && matchBlockRule(from.email, senderRules)) {
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
        // 混雑（429/529）や一時的な障害はジョブごと後でやり直す。それ以外（と、やり直しても通らないとき）は要確認として置く
        if (isRetryableApiError(err) && !opts.fallbackOnBusy) throw err;
        console.error("classification failed", gmailMessageId, err);
        await recordClaudeResult(db, describeClaudeError(err)).catch(() => undefined);
        content = null;
      }
      if (content) await recordClaudeResult(db, null).catch(() => undefined);
    }
  }

  const merged: MergedClassification = bulkToPersonal
    ? { folder: "info", category: "info", secondaryFolders: stage1.secondaryFolders, source: "content", needsReview: false }
    : mergeClassification(stage1, content);
  // 返信が要ると判定されても、このメールより後に自分たちが返信していれば対応済み（過去メールの取り込みで多い）
  // グループ宛てで同僚が既に返信したメールも対応済み（届くのが同僚の返信より後になった人の受信箱）
  let needsReply = content?.needs_reply ?? false;
  let answered = opts.keepStatus === "replied";
  if (needsReply && !answered) {
    answered = (await repliedByColleague(db, user, msg.messageIdHeader)) || (await answeredLater(mail, user, msg));
  }
  if (answered) needsReply = false;

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
  await applyLabels(mail, msg, merged, needsReply, answered);

  // 見られないフォルダのメールには、その人の受信箱で下書きを作らない。過去メールの取り込みでは下書きも通知も出さない
  const visible = canSeeMessage(user, { folder: merged.folder, secondaryFolders: merged.secondaryFolders });
  const live = needsReply && visible && opts.autoDraft !== false;
  const autoDraft = live ? await getSetting(db, "autoDraft") : null;
  const key: Folder = merged.category ?? merged.folder;
  const wantDraft = Boolean(autoDraft && (autoDraft[key] ?? true));
  // 通知：既定は「至急の要返信」だけ
  const notify = live ? await getSetting(db, "notify") : null;
  const urgent = content?.urgency === "high";
  const wantNotify = Boolean(notify && (notify.mode === "replies" || (notify.mode === "urgent" && urgent)));
  let draftQueued = false;

  const messageRowId = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    if (restoredRowId !== null) {
      await tx
        .delete(dateCandidates)
        .where(
          and(
            eq(dateCandidates.userId, user.id),
            eq(dateCandidates.gmailMessageId, gmailMessageId),
            eq(dateCandidates.status, "candidate"),
          ),
        );
      // 同時に別の処理が戻していれば（行が skipped でなくなっていれば）何もしない
      const removed = await tx
        .delete(messages)
        .where(and(eq(messages.id, restoredRowId), eq(messages.status, "skipped")))
        .returning({ id: messages.id });
      if (!removed.length) return null;
    }
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
      status: needsReply ? (opts.keepStatus === "draft_ready" ? "draft_ready" : "new") : answered ? "replied" : "done",
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
    const rowId = inserted[0].id;
    // 下書き・通知のジョブも同じトランザクションで積む。行だけ残ってジョブを積めずに落ちると、
    // やり直しは「処理済み」で終わるので、自動の下書きも通知も失われる
    if (wantDraft) {
      // グループ宛てで複数人に届いたメールは、最初に処理した1人の受信箱にだけ自動で下書きを作る
      const dedupe = msg.messageIdHeader ? `draft:rfc:${msg.messageIdHeader}` : `draft:${user.id}:${msg.id}`;
      draftQueued = await enqueue(
        tx,
        "generate_draft",
        { userId: user.id, threadId: msg.threadId, messageId: msg.id, generatedBy: "auto" },
        dedupe,
      );
    }
    if (wantNotify) {
      await enqueue(
        tx,
        "notify",
        {
          userId: user.id,
          title: `${urgent ? "【至急】" : ""}${from.name || from.email}`,
          body: content?.summary || msg.subject,
          url: `/m/${rowId}`,
          tag: `msg-${rowId}`,
        },
        `notify:${user.id}:${msg.id}`,
      );
    }
    return rowId;
  });
  if (messageRowId === null) return { kind: "skipped", reason: "already_processed" };

  return { kind: "classified", messageRowId, merged, draftQueued };
}

async function applyLabels(
  mail: MailApi,
  msg: ParsedMessage,
  merged: MergedClassification,
  needsReply: boolean,
  answered: boolean,
): Promise<void> {
  const labels = new LabelResolver(mail);
  const add = [await labels.folderId(merged.folder)];
  for (const f of merged.secondaryFolders) if (isFolder(f)) add.push(await labels.folderId(f));
  if (needsReply) add.push(await labels.statusId("needsReply"));
  // 返信済みとして記録するメールには、返信を記録したときと同じく対応済のラベルを付ける
  if (answered) add.push(await labels.statusId("done"));
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
      // 社内への転送は返信ではない
      if (ours && FORWARD_SUBJECT.test(header(m, "Subject") ?? "")) return false;
      return ours && Number(m.internalDate ?? 0) > msg.date.getTime();
    });
  } catch {
    return false;
  }
}
