import { and, desc, eq, inArray, ne } from "drizzle-orm";
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
import { freeWindows, proposeSlots } from "./slots";
import { addDays, formatJst, fromJst, jstParts, startOfJstDay } from "./time";
import type { ShopInfo } from "./shopify";
import type { DraftTools } from "./claude/drafter";
import { PermanentJobError } from "./jobs";

export interface DraftDeps {
  db: Db;
  mail: MailApi;
  drafter: DraftWriter;
  calendar: CalendarApi | null;
  shop: ShopInfo | null;
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

/**
 * Gmail で作られた下書き（Claude のスキルや Gmail の画面で作ったもの）をアプリに取り込む。
 * アプリが知っているスレッドの返信下書きだけを対象にし、取り込んだメールは「下書きあり」にする。
 * threadId を渡せばそのスレッドだけ。戻り値は取り込んだ件数。
 */
export async function adoptGmailDrafts(db: Db, mail: MailApi, user: User, threadId?: string): Promise<number> {
  const gmailDrafts = (await mail.listDrafts(200)).filter((d) => !threadId || d.threadId === threadId);
  if (!gmailDrafts.length) return 0;
  const known = new Set(
    (
      await db
        .select({ id: drafts.gmailDraftId })
        .from(drafts)
        .where(and(eq(drafts.userId, user.id), inArray(drafts.gmailDraftId, gmailDrafts.map((d) => d.draftId))))
    ).map((r) => r.id),
  );
  let adopted = 0;
  let labels: LabelResolver | null = null;
  for (const d of gmailDrafts) {
    if (known.has(d.draftId)) continue;
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), eq(messages.gmailThreadId, d.threadId), ne(messages.status, "skipped")))
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .limit(1);
    const row = rows[0];
    if (!row) continue; // 新規作成の下書きや、アプリが扱っていないスレッド
    const current = await mail.getDraft(d.draftId);
    if (!current) continue;
    await db.insert(drafts).values({
      userId: user.id,
      gmailThreadId: d.threadId,
      replyToMessageId: row.gmailMessageId,
      gmailDraftId: d.draftId,
      bodyHash: bodyHash(draftText(parseMessage(current.message))),
      notes: "Gmail で作られた下書きです（Claude のスキルや Gmail の画面で作成）",
      generatedBy: "gmail",
    });
    await db
      .update(messages)
      .set({ status: "draft_ready" })
      .where(and(eq(messages.userId, user.id), eq(messages.gmailThreadId, d.threadId), eq(messages.status, "new")));
    labels ??= new LabelResolver(mail);
    await mail.modifyMessage(row.gmailMessageId, [await labels.statusId("draftReady")], []).catch(() => undefined);
    adopted++;
  }
  return adopted;
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

  // Claude のスキルなどで Gmail に下書きが既にあれば、自動では作らずそれを取り込む
  if (opts.generatedBy === "auto" && (thread.messages ?? []).some((m) => m.labelIds?.includes("DRAFT"))) {
    await adoptGmailDrafts(db, mail, user, threadId);
    if (await latestDraft(db, user.id, threadId)) return { kind: "skipped", reason: "下書きが既にあります" };
  }

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
    senderEmail: target.from.email,
    thread: threadForDraft,
    now: formatJst(new Date()),
    tools: {
      shop: deps.shop,
      calendar: deps.calendar ? calendarTools(db, deps.calendar) : null,
    },
    wantSlots: Boolean(opts.withSlots),
    instruction: opts.instruction ?? null,
    previousDraft: opts.instruction ? previousText : null,
  });

  const notes = result.lookups?.length ? `${result.notes}\n確認した情報: ${result.lookups.join("、")}` : result.notes;
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
        notes,
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
        notes,
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

const MAX_CHECK_DAYS = 14;

function parseJstDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = fromJst(Number(m[1]), Number(m[2]), Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const hm = (d: Date) => {
  const p = jstParts(d);
  return `${p.hour}:${String(p.minute).padStart(2, "0")}`;
};

/** 下書きを書く Claude に渡すカレンダーの調べもの（営業時間と、設定でつないだカレンダーを見る） */
export function calendarTools(db: Db, calendar: CalendarApi, now = new Date()): NonNullable<DraftTools["calendar"]> {
  const load = async () => {
    const [hours, calendarMap] = await Promise.all([getSetting(db, "businessHours"), getSetting(db, "calendarMap")]);
    return { hours, ids: [...new Set(Object.values(calendarMap))] };
  };
  return {
    async check(fromDate, toDate) {
      const from = parseJstDate(fromDate);
      const to = parseJstDate(toDate) ?? from;
      if (!from || !to) return "日付は YYYY-MM-DD で指定してください。";
      const days = Math.min(MAX_CHECK_DAYS, Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1));
      const end = addDays(from, days);
      const { hours, ids } = await load();
      const [busy, events] = await Promise.all([
        calendar.freeBusy(ids, from, end),
        Promise.all(ids.map((id) => calendar.listEvents(id, from, end).catch(() => []))).then((l) => {
          // 同じ予定が複数のカレンダーに出ることがある（共有カレンダーなど）
          const seen = new Set<string>();
          return l.flat().filter((e) => !seen.has(`${e.id}|${e.start}`) && Boolean(seen.add(`${e.id}|${e.start}`)));
        }),
      ]);
      const lines = [`営業時間: ${hours.start}〜${hours.end}（営業日以外は「休み」）`];
      for (let i = 0; i < days; i++) {
        const day = addDays(from, i);
        const next = addDays(day, 1);
        const dayEvents = events
          .filter((e) => {
            const s = e.allDay ? parseJstDate(e.start) ?? new Date(e.start) : new Date(e.start);
            return s >= day && s < next;
          })
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((e) => (e.allDay ? `終日 ${e.summary}` : `${hm(new Date(e.start))}〜${hm(new Date(e.end))} ${e.summary}`));
        const open = freeWindows(busy, hours, day);
        const isOpenDay = hours.days.includes(jstParts(day).weekday);
        lines.push(
          `${formatJst(day, false)}: ${isOpenDay ? "" : "休み。"}予定 ${dayEvents.length ? dayEvents.join(" / ") : "なし"}。` +
            (isOpenDay ? `空き ${open.length ? open.map((w) => `${hm(w.start)}〜${hm(w.end)}`).join("、") : "なし"}` : ""),
        );
      }
      if (days < Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1) lines.push(`（${MAX_CHECK_DAYS}日分だけ表示しています）`);
      return lines.join("\n");
    },
    async freeSlots(opts) {
      const { hours, ids } = await load();
      const start = opts.fromDate ? parseJstDate(opts.fromDate) : null;
      // 指定日が今から24時間以内なら、急な候補を避けるため24時間後から
      const from = start && start > now ? start : now;
      const leadHours = Math.max(0, (now.getTime() + 24 * 3600_000 - from.getTime()) / 3600_000);
      const days = opts.days ?? 21;
      const busy = await calendar.freeBusy(ids, startOfJstDay(from), addDays(from, days + 1));
      const duration = opts.durationMinutes ?? hours.slotMinutes;
      const slots = proposeSlots({ busy, hours, from, days, durationMinutes: duration, count: opts.count ?? 3, leadHours });
      if (!slots.length) return `${days}日以内に${duration}分の空きは見つかりませんでした。`;
      return slots.map((s) => `- ${formatJst(s.start)}〜${hm(s.end)}`).join("\n");
    },
  };
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

