import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./db";
import { contacts, drafts, messages, playbooks, type DraftRow, type User } from "./db/schema";
import type { DraftWriter, ThreadMessageForDraft } from "./claude/drafter";
import { isCategory, LANGUAGES, type Language } from "./domain";
import type { CalendarApi } from "./google/calendar-api";
import type { MailApi } from "./google/mail-api";
import { LabelResolver } from "./labels";
import { buildMime, replySubject } from "./mail/mime";
import { parseMessage, stripQuoted, type Address, type ParsedMessage } from "./mail/parse";
import { bodyHash } from "./crypto";
import { getSetting } from "./settings";
import { proposeSlots } from "./slots";
import { formatJst } from "./time";
import type { OrderLookup } from "./shopify";
import { PermanentJobError } from "./jobs";

export interface DraftDeps {
  db: Db;
  mail: MailApi;
  drafter: DraftWriter;
  calendar: CalendarApi | null;
  orders: OrderLookup | null;
}

export interface GenerateOptions {
  generatedBy: "auto" | "manual";
  instruction?: string | null;
  /** 空き時間の候補を下書きに入れる */
  withSlots?: boolean;
}

export type GenerateResult =
  | { kind: "created"; draft: DraftRow; alternative: boolean }
  | { kind: "updated"; draft: DraftRow }
  | { kind: "skipped"; reason: string };

/** 自動で空き時間を添えるカテゴリ（日程調整が多いもの） */
const SLOT_CATEGORIES = new Set(["tour", "intern"]);

export function draftText(message: ParsedMessage): string {
  return message.text.replace(/\r\n/g, "\n").trim();
}

/** 返信の送信元：相手が送ってきた用途別アドレスが「送信元として使える」ならそれ */
export function chooseFrom(target: ParsedMessage, sendAs: Address[], businessAddresses: Set<string>): Address | null {
  const candidates = [...target.to, ...target.cc].map((a) => a.email.toLowerCase());
  for (const email of candidates) {
    if (!businessAddresses.has(email)) continue;
    const alias = sendAs.find((s) => s.email === email);
    if (alias) return alias;
  }
  return null;
}

export async function latestDraft(db: Db, userId: number, threadId: string): Promise<DraftRow | null> {
  const rows = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.gmailThreadId, threadId), eq(drafts.status, "ready")))
    .orderBy(desc(drafts.createdAt), desc(drafts.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function generateDraft(
  deps: DraftDeps,
  user: User,
  threadId: string,
  replyToMessageId: string | null,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const { db, mail, drafter } = deps;
  const thread = await mail.getThread(threadId);
  const parsed = (thread.messages ?? []).map(parseMessage).filter((m) => !m.labelIds.includes("DRAFT"));
  if (!parsed.length) throw new PermanentJobError("スレッドが見つかりません");
  const isOurs = (m: ParsedMessage) => m.labelIds.includes("SENT") || m.from?.email === user.email;
  const target =
    parsed.find((m) => m.id === replyToMessageId) ?? [...parsed].reverse().find((m) => !isOurs(m)) ?? null;
  if (!target || !target.from) return { kind: "skipped", reason: "返信する相手のメールがありません" };

  const previous = await latestDraft(db, user.id, threadId);
  let previousText: string | null = null;
  let humanEdited = false;
  if (previous) {
    const current = await mail.getDraft(previous.gmailDraftId);
    if (!current) {
      // Gmail 側で送信・削除された
      await db.update(drafts).set({ status: "discarded" }).where(eq(drafts.id, previous.id));
    } else {
      previousText = draftText(parseMessage(current.message));
      humanEdited = bodyHash(previousText) !== previous.bodyHash;
      if (opts.generatedBy === "auto") return { kind: "skipped", reason: "下書きが既にあります" };
    }
  }
  const livePrevious = previousText !== null ? previous : null;

  const row = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), eq(messages.gmailMessageId, target.id)))
      .limit(1)
  )[0];
  const category = row?.category && isCategory(row.category) ? row.category : null;
  const language: Language = (LANGUAGES as readonly string[]).includes(row?.language ?? "")
    ? (row?.language as Language)
    : "ja";

  const contact = (await db.select().from(contacts).where(eq(contacts.email, target.from.email)).limit(1))[0];
  const priorFromSender = parsed.filter((m) => m.from?.email === target.from?.email).length > 1;
  const knownContact = Boolean(contact?.notes || contact?.lastSummary || priorFromSender || parsed.some(isOurs));

  const [playbookRows, businessContext, signatures] = await Promise.all([
    db.select().from(playbooks),
    getSetting(db, "businessContext"),
    getSetting(db, "signatures"),
  ]);

  const businessAddresses = new Set(
    (await db.query.addressMap.findMany()).map((a) => a.address.toLowerCase()),
  );
  const sendAs = await mail.sendAsAddresses().catch(() => [] as Address[]);
  const from = chooseFrom(target, sendAs, businessAddresses);
  const sigSet = (from && signatures.byAddress[from.email]) || {};
  const signature = language === "ja" ? (sigSet.ja ?? signatures.ja) : (sigSet.en ?? signatures.en);

  let slots: string[] = [];
  if (deps.calendar && (opts.withSlots || (opts.generatedBy === "auto" && category && SLOT_CATEGORIES.has(category)))) {
    slots = await freeSlotTexts(db, deps.calendar).catch((err) => {
      console.error("slot lookup failed", err);
      return [];
    });
  }

  let orders: string | null = null;
  if (deps.orders && category === "order") {
    orders = await deps.orders.ordersForEmail(target.from.email).catch((err) => {
      console.error("shopify lookup failed", err);
      return null;
    });
  }

  const threadForDraft: ThreadMessageForDraft[] = parsed.slice(-10).map((m) => ({
    from: m.from ? (m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email) : "不明",
    date: formatJst(m.date),
    text: (stripQuoted(m.text) || m.text).slice(0, 8000),
    fromUs: isOurs(m),
  }));

  const result = await drafter.write({
    businessContext,
    playbooks: Object.fromEntries(playbookRows.map((p) => [p.category, p.guidance])),
    category,
    language,
    summary: row?.summary ?? target.subject,
    senderName: target.from.name,
    knownContact,
    contactNotes: contact?.notes ?? "",
    contactSummary: contact?.lastSummary ?? "",
    signature,
    thread: threadForDraft,
    slots,
    orders,
    instruction: opts.instruction ?? null,
    previousDraft: opts.instruction ? previousText : null,
  });

  const replyTo = target.replyTo ?? target.from;
  const raw = buildMime({
    from,
    to: [replyTo],
    subject: replySubject(target.subject),
    text: result.body,
    inReplyTo: target.messageIdHeader,
    references: target.references,
  });

  let outcome: GenerateResult;
  if (livePrevious && !humanEdited) {
    // 人が触っていない下書きは同じ下書きを差し替える
    await mail.updateDraft(livePrevious.gmailDraftId, raw, threadId);
    const [updated] = await db
      .update(drafts)
      .set({
        version: livePrevious.version + 1,
        bodyHash: bodyHash(result.body),
        notes: result.notes,
        instruction: opts.instruction ?? null,
        generatedBy: opts.generatedBy,
      })
      .where(eq(drafts.id, livePrevious.id))
      .returning();
    outcome = { kind: "updated", draft: updated };
  } else {
    // 初めて作る、または人が直した下書きがある（上書きせず別案として並べる）
    const ref = await mail.createDraft(raw, threadId);
    const [created] = await db
      .insert(drafts)
      .values({
        userId: user.id,
        gmailThreadId: threadId,
        replyToMessageId: target.id,
        gmailDraftId: ref.draftId,
        version: livePrevious ? livePrevious.version + 1 : 1,
        bodyHash: bodyHash(result.body),
        notes: result.notes,
        instruction: opts.instruction ?? null,
        generatedBy: opts.generatedBy,
      })
      .returning();
    outcome = { kind: "created", draft: created, alternative: Boolean(livePrevious) };
  }

  if (row) {
    await db
      .update(messages)
      .set({ status: row.status === "new" ? "draft_ready" : row.status })
      .where(eq(messages.id, row.id));
  }
  const labels = new LabelResolver(mail);
  await mail.modifyMessage(target.id, [await labels.statusId("draftReady")], []);
  return outcome;
}

export async function freeSlotTexts(db: Db, calendar: CalendarApi, now = new Date()): Promise<string[]> {
  const [hours, calendarMap] = await Promise.all([getSetting(db, "businessHours"), getSetting(db, "calendarMap")]);
  const ids = [...new Set(Object.values(calendarMap))];
  const until = new Date(now.getTime() + 21 * 24 * 3600 * 1000);
  const busy = await calendar.freeBusy(ids, now, until);
  return proposeSlots({ busy, hours, from: now, days: 21, durationMinutes: hours.slotMinutes, count: 3 }).map(
    (s) => `${formatJst(s.start)}〜${formatJst(s.end).split(" ")[1]}`,
  );
}

/** Gmail の下書きの宛先・件名を保ったまま本文だけ差し替える（人が画面で編集して保存したとき） */
export async function saveDraftText(
  mail: MailApi,
  draftId: string,
  threadId: string,
  text: string,
): Promise<void> {
  const current = await mail.getDraft(draftId);
  if (!current) throw new Error("下書きが Gmail に見つかりません（送信済みか削除済み）");
  const m = parseMessage(current.message);
  // 本文が変わっていなければ作り直さない（Gmail の画面で足した添付や書式を消さないため）
  if (draftText(m) === text.replace(/\r\n/g, "\n").trim()) return;
  const header = (name: string) =>
    current.message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
  const inReplyTo = header("In-Reply-To");
  const refs = header("References");
  // buildMime が References の末尾に In-Reply-To を足すので、重複しないよう外しておく
  const refsWithoutParent = inReplyTo && refs ? refs.replace(inReplyTo, "").trim() : refs;
  const raw = buildMime({
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    text,
    inReplyTo,
    references: refsWithoutParent || null,
  });
  await mail.updateDraft(draftId, raw, threadId);
}

