import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { drafts, jobs, messages, type User } from "@/lib/db/schema";
import { setDb, type Db } from "@/lib/db";
import { runJobs } from "@/lib/jobs";
import { jobHandlers } from "@/lib/services";
import { requeueUnclassified, syncUser } from "@/lib/sync";
import { filterCounts, folderCounts, listMessages, totalReplyCount, unreadNewsletterCount } from "@/lib/queries";
import type { ClassifierInput, ContentClassification } from "@/lib/classify/types";
import type { DraftRequest } from "@/lib/claude/drafter";
import type { CalendarApi } from "@/lib/google/calendar-api";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage, type FixtureInput } from "./helpers/fake-mail";

/**
 * 利用者の一連の操作（届く → 分類 → 下書き → 送信 → 返事が来る …）を、本番と同じ部品
 * （同期・ジョブキュー・jobHandlers・サーバーアクション・一覧のクエリ）でつないで確かめる。
 * Gmail・Claude・ログインだけを差し替える。
 */
const h = vi.hoisted(() => ({
  user: null as User | null,
  /** refreshTokenEnc → その人の Gmail */
  mails: new Map<string, unknown>(),
  classify: null as null | ((input: ClassifierInput) => Promise<ContentClassification>),
  draftRequests: [] as DraftRequest[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  unstable_rethrow: () => undefined,
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => h.user }));
vi.mock("@/lib/google/oauth", async (orig) => ({
  ...(await orig<typeof import("@/lib/google/oauth")>()),
  clientForRefreshToken: (enc: string) => enc,
}));
vi.mock("@/lib/google/gmail", () => ({
  GoogleMailApi: class {
    constructor(enc: string) {
      const mail = h.mails.get(enc);
      if (!mail) throw new Error(`no fake mail for ${enc}`);
      return mail as object;
    }
  },
}));
vi.mock("@/lib/google/calendar", () => ({
  GoogleCalendarApi: class {
    listCalendars = async () => [];
    freeBusy = async () => [];
    listEvents = async () => [];
    insertEvent = async () => ({ id: "e1", htmlLink: null });
    patchEvent = async () => {};
  } satisfies new () => CalendarApi,
}));
vi.mock("@/lib/claude/classifier", () => ({
  ClaudeClassifier: class {
    classify(input: ClassifierInput) {
      if (!h.classify) throw new Error("classifier not set");
      return h.classify(input);
    }
  },
}));
vi.mock("@/lib/claude/drafter", async (orig) => ({
  ...(await orig<typeof import("@/lib/claude/drafter")>()),
  ClaudeDraftWriter: class {
    async write(req: DraftRequest) {
      h.draftRequests.push(req);
      return { notes: "問合せへの返信", body: `${req.senderName ?? ""} 様\nお問合せありがとうございます。(${h.draftRequests.length})` };
    }
  },
}));

/** 本物の Gmail に近づけた FakeMail：ラベルの付け外し・ゴミ箱をメールに反映し、下書きを送れる */
class Gmail extends FakeMail {
  trashed: string[] = [];
  constructor(public owner: string) {
    super();
  }
  private apply(ids: string[], add: string[], remove: string[]) {
    for (const id of ids) {
      const m = this.messages.get(id);
      if (!m) continue;
      const labels = new Set(m.labelIds ?? []);
      for (const l of add) labels.add(l);
      for (const l of remove) labels.delete(l);
      m.labelIds = [...labels];
    }
  }
  override async modifyMessage(id: string, add: string[], remove: string[]) {
    await super.modifyMessage(id, add, remove);
    this.apply([id], add, remove);
  }
  override async modifyThread(threadId: string, add: string[], remove: string[]) {
    await super.modifyThread(threadId, add, remove);
    this.apply(
      [...this.messages.values()].filter((m) => m.threadId === threadId).map((m) => m.id ?? ""),
      add,
      remove,
    );
  }
  override async trashMessage(id?: string) {
    this.trashed.push(id ?? "");
    this.apply([id ?? ""], ["TRASH"], ["INBOX"]);
  }
  receive(f: FixtureInput) {
    this.add(gmailMessage({ messageId: `<${f.id}@mail.example>`, ...f }));
  }
  /** ブラウザから下書きを送った：Gmail では下書きが消え、送信済みのメールがスレッドに入る */
  sendDraft(draftId: string, id: string, date: Date) {
    const d = this.drafts.get(draftId);
    if (!d) throw new Error("no draft");
    this.drafts.delete(draftId);
    this.add(gmailMessage({ id, threadId: d.threadId ?? "", from: this.owner, to: "guest@example.com", labelIds: ["SENT"], date, subject: "Re: 件名" }));
  }
  /** 自分が Gmail の画面から直接返信した */
  reply(threadId: string, id: string, date: Date) {
    this.add(gmailMessage({ id, threadId, from: this.owner, to: "guest@example.com", labelIds: ["SENT"], date, subject: "Re: 件名" }));
  }
  labelNamesOf(id: string): string[] {
    return (this.messages.get(id)?.labelIds ?? []).map((l) => this.labelName(l) ?? l);
  }
}

const classification = (over: Partial<ContentClassification> = {}): ContentClassification => ({
  category: "wholesale",
  needs_reply: true,
  urgency: "normal",
  language: "ja",
  dates: [],
  amount: null,
  due_date: null,
  summary: "卸の問合せ",
  accepts_proposed_time: false,
  confidence: 0.95,
  ...over,
});

async function setup() {
  const db = await testDb();
  const owner = await makeUser(db, { refreshTokenEnc: "owner", historyId: "100" });
  const mail = new Gmail(owner.email);
  h.mails.set("owner", mail);
  setDb(db);
  h.user = owner;
  return { db, owner, mail };
}

/** push 通知が来たときと同じ：履歴を読んでジョブに積み、ジョブを進める */
async function sync(db: Db, user: User, mail: Gmail) {
  const fresh = (await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, user.id) }))!;
  await syncUser(db, mail, fresh);
  await runJobs(db, jobHandlers(db), 10_000);
}

const T0 = new Date("2026-11-10T01:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * 3600_000);
const rowOf = async (db: Db, userId: number, gmailMessageId: string) =>
  (await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.gmailMessageId, gmailMessageId))))[0];

beforeEach(() => {
  h.user = null;
  h.mails.clear();
  h.draftRequests = [];
  h.classify = async () => classification();
  return () => setDb(null);
});

describe("お客様のメールが届いてから返信するまで", () => {
  /** 新しい問合せが届き、自動の下書きができ、アプリから送信するまで */
  async function firstReply() {
    const ctx = await setup();
    const { db, owner, mail } = ctx;
    // 別の相手からの、返信の要らないメール（後で並び順を確かめる）
    h.classify = async (input) =>
      input.subject === "お知らせ" ? classification({ category: "general", needs_reply: false, summary: "お知らせ" }) : classification();
    mail.receive({ id: "other", threadId: "t-other", from: "Shop <shop@x.example>", to: "info@yusando.com", subject: "お知らせ", date: at(1) });
    mail.receive({ id: "m1", threadId: "t1", from: "Ben <ben@cha.example>", to: "wholesale@yusando.com", subject: "抹茶 5kg", date: at(0) });
    await sync(db, owner, mail);

    // 分類して保存し、下書きを自動で作る
    expect(await rowOf(db, owner.id, "m1")).toMatchObject({ folder: "wholesale", needsReply: true, status: "draft_ready" });
    const [draft] = await db.select().from(drafts).where(eq(drafts.gmailThreadId, "t1"));
    expect(draft).toMatchObject({ status: "ready", generatedBy: "auto", replyToMessageId: "m1" });
    const gmailDraft = mail.drafts.get(draft.gmailDraftId)!;
    expect(gmailDraft.threadId).toBe("t1");
    expect(gmailDraft.raw).toContain("In-Reply-To: <m1@mail.example>");
    expect(mail.labelNamesOf("m1")).toEqual(expect.arrayContaining(["悠三堂/卸売", "状態/要返信", "状態/下書きあり"]));
    expect((await db.select().from(jobs)).every((j) => j.status === "done")).toBe(true);

    // 一覧：「下書き」に出て、行には下書きありと出す
    const draftList = await listMessages(db, owner, { folder: null, filter: "draft", page: 0 });
    expect(draftList.map((r) => r.gmailMessageId)).toEqual(["m1"]);
    expect(draftList[0]).toMatchObject({ threadDraft: true, threadOpen: true, threadUnread: true });
    expect(await filterCounts(db, owner, null)).toEqual({ reply: 1, draft: 1, review: 0 });
    expect(await totalReplyCount(db, owner)).toBe(1);

    // アプリから送信（送信そのものはブラウザ。送れたらサーバーに知らせる）
    const { markSentAction } = await import("@/app/actions/mail");
    expect(await markSentAction(draft.id)).toEqual({ ok: true });
    expect(await rowOf(db, owner.id, "m1")).toMatchObject({ status: "replied", needsReply: false });
    expect((await db.select().from(drafts).where(eq(drafts.id, draft.id)))[0].status).toBe("sent");
    expect(mail.labelNamesOf("m1")).toContain("状態/対応済");
    expect(mail.labelNamesOf("m1")).not.toContain("状態/要返信");
    expect(mail.labelNamesOf("m1")).not.toContain("状態/下書きあり");

    // Gmail からは送信済みのメールが同期されてくる（返信として記録するだけで、何も戻さない）
    mail.sendDraft(draft.gmailDraftId, "s1", at(2));
    await sync(db, owner, mail);
    expect(await rowOf(db, owner.id, "m1")).toMatchObject({ status: "replied", needsReply: false });
    expect(await rowOf(db, owner.id, "s1")).toBeUndefined();
    expect(await listMessages(db, owner, { folder: null, filter: "reply", page: 0 })).toEqual([]);
    expect(await totalReplyCount(db, owner)).toBe(0);
    expect((await folderCounts(db, owner)).get("wholesale")?.reply ?? 0).toBe(0);
    return ctx;
  }

  it("届く → 分類 → 自動の下書き → 一覧に下書き → 送信で対応済", async () => {
    await firstReply();
  });

  it("同じスレッドにお客様からまた返事が来ると、スレッドが一番上に戻って要返信になる", async () => {
    const { db, owner, mail } = await firstReply();
    // この時点では、後から届いた別のメールのほうが上
    expect((await listMessages(db, owner, { folder: null, filter: "all", page: 0 })).map((r) => r.gmailMessageId)).toEqual(["other", "m1"]);

    mail.receive({ id: "m2", threadId: "t1", from: "Ben <ben@cha.example>", to: "wholesale@yusando.com", subject: "Re: 抹茶 5kg", date: at(30) });
    await sync(db, owner, mail);

    const all = await listMessages(db, owner, { folder: null, filter: "all", page: 0 });
    expect(all.map((r) => r.gmailMessageId)).toEqual(["m2", "other"]);
    expect(all[0]).toMatchObject({ threadCount: 2, threadOpen: true, threadUnread: true });
    expect(await rowOf(db, owner.id, "m1")).toMatchObject({ status: "replied" });
    expect(await rowOf(db, owner.id, "m2")).toMatchObject({ needsReply: true });
    expect((await listMessages(db, owner, { folder: null, filter: "reply", page: 0 })).map((r) => r.gmailMessageId)).toEqual(["m2"]);
    expect(await totalReplyCount(db, owner)).toBe(1);
    expect((await folderCounts(db, owner)).get("wholesale")?.reply).toBe(1);
    // 新しいメールへの下書きを作り直す（前の下書きは送信済みなので別に作る）
    const ready = await db.select().from(drafts).where(and(eq(drafts.gmailThreadId, "t1"), eq(drafts.status, "ready")));
    expect(ready).toHaveLength(1);
    expect(ready[0].replyToMessageId).toBe("m2");
    expect(mail.drafts.get(ready[0].gmailDraftId)!.raw).toContain("In-Reply-To: <m2@mail.example>");
  });
});

describe("グループ宛てのメール", () => {
  it("2人に届いたメールに1人が返信すると、2人とも対応済になり、もう1人の下書きも出さない", async () => {
    const { db, owner, mail } = await setup();
    const staff = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["tour"], refreshTokenEnc: "staff", historyId: "100" });
    const staffMail = new Gmail(staff.email);
    h.mails.set("staff", staffMail);
    let classified = 0;
    h.classify = async () => {
      classified++;
      return classification({ category: "tour", summary: "ツアーの問合せ" });
    };
    const group = { from: "Guest <guest@t.example>", to: "tour@yusando.com", subject: "ツアー予約", messageId: "<group-1@t.example>", date: at(0) };
    mail.receive({ id: "xa", threadId: "ta", ...group });
    staffMail.receive({ id: "xb", threadId: "tb", ...group });
    await sync(db, owner, mail);
    await sync(db, staff, staffMail);

    // 分類は1回、自動の下書きは最初に処理した1人（代表）の受信箱にだけ
    expect(classified).toBe(1);
    expect(await rowOf(db, owner.id, "xa")).toMatchObject({ status: "draft_ready", needsReply: true });
    expect(await rowOf(db, staff.id, "xb")).toMatchObject({ status: "new", needsReply: true });
    expect(await db.select().from(drafts)).toHaveLength(1);
    expect(await totalReplyCount(db, staff)).toBe(1);

    // 担当者が Gmail から返信した
    staffMail.reply("tb", "out", at(3));
    await sync(db, staff, staffMail);

    expect(await rowOf(db, staff.id, "xb")).toMatchObject({ status: "replied", needsReply: false });
    expect(await rowOf(db, owner.id, "xa")).toMatchObject({ status: "replied", needsReply: false });
    for (const u of [owner, staff]) {
      expect(await listMessages(db, u, { folder: null, filter: "reply", page: 0 })).toEqual([]);
      expect(await totalReplyCount(db, u)).toBe(0);
    }
    // 代表の Gmail のラベルはジョブ（代表の権限）で揃える
    expect((await db.select().from(jobs).where(eq(jobs.kind, "mark_replied")))[0]).toMatchObject({ status: "done" });
    expect(mail.labelNamesOf("xa")).toContain("状態/対応済");
    expect(mail.labelNamesOf("xa")).not.toContain("状態/要返信");
    expect(mail.labelNamesOf("xa")).not.toContain("状態/下書きあり");
    // 代表の受信箱の自動の下書きは役目を終えた（メール画面に出して二重に送らせない）
    expect((await db.select().from(drafts))[0].status).toBe("discarded");
  });
});

describe("一覧からのアーカイブ・削除", () => {
  it("スレッドごと一覧から消え、左の件数・絞り込みの件数も減る", async () => {
    const { db, owner, mail } = await setup();
    h.classify = async (input) =>
      input.subject === "ニュースレター"
        ? classification({ category: "info", needs_reply: false, summary: "ニュースレター" })
        : classification({ category: "order", summary: "注文の問合せ" });
    mail.receive({ id: "a1", threadId: "ta", from: "a@c.example", to: "order@yusando.com", subject: "注文", date: at(0) });
    mail.receive({ id: "a2", threadId: "ta", from: "a@c.example", to: "order@yusando.com", subject: "注文", date: at(1) });
    mail.receive({ id: "b1", threadId: "tb", from: "b@c.example", to: "order@yusando.com", subject: "注文", date: at(2) });
    mail.receive({ id: "c1", threadId: "tc", from: "c@c.example", to: "order@yusando.com", subject: "注文", date: at(3) });
    mail.receive({ id: "n1", threadId: "tn", from: "news@n.example", to: "info@yusando.com", subject: "ニュースレター", date: at(4) });
    await sync(db, owner, mail);

    const inbox = () => listMessages(db, owner, { folder: null, filter: "all", page: 0 }).then((r) => r.map((m) => m.gmailMessageId));
    expect(await inbox()).toEqual(["c1", "b1", "a2"]);
    expect(await totalReplyCount(db, owner)).toBe(3);
    expect((await folderCounts(db, owner)).get("order")).toMatchObject({ reply: 3, unread: 3 });
    expect(await unreadNewsletterCount(db, owner)).toBe(1);

    const { bulkRemoveAction } = await import("@/app/actions/mail");
    const ids = Object.fromEntries((await db.select().from(messages)).map((r) => [r.gmailMessageId, r.id]));
    // チェックして「アーカイブ」（行はスレッドの最新の1通だが、スレッドの全メールを外す）
    const form = new FormData();
    form.set("kind", "archive");
    form.append("sel", String(ids.a2));
    form.set("back", "/inbox");
    await expect(bulkRemoveAction(form)).rejects.toThrow(/REDIRECT:\/inbox\?notice=1/);
    expect((await rowOf(db, owner.id, "a1")).status).toBe("archived");
    expect((await rowOf(db, owner.id, "a2")).status).toBe("archived");
    expect(mail.labelNamesOf("a1")).not.toContain("INBOX");
    expect(mail.labelNamesOf("a2")).not.toContain("状態/要返信");
    expect(await inbox()).toEqual(["c1", "b1"]);
    expect(await totalReplyCount(db, owner)).toBe(2);
    expect((await folderCounts(db, owner)).get("order")).toMatchObject({ reply: 2, unread: 2 });
    expect(await filterCounts(db, owner, null)).toMatchObject({ reply: 2 });

    // 行の × ボタン（1通だけ）でゴミ箱へ
    const trash = new FormData();
    trash.set("only", `trash:${ids.b1}`);
    trash.set("back", "/inbox?folder=order");
    await expect(bulkRemoveAction(trash)).rejects.toThrow(/REDIRECT:\/inbox\?folder=order&notice=/);
    expect(mail.trashed).toEqual(["b1"]);
    expect((await rowOf(db, owner.id, "b1")).status).toBe("skipped");
    expect(await inbox()).toEqual(["c1"]);
    expect(await totalReplyCount(db, owner)).toBe(1);
    expect((await folderCounts(db, owner)).get("order")).toMatchObject({ reply: 1, unread: 1 });

    // ニュースレターをアーカイブすると、受信箱の上の未読の数も減る
    const news = new FormData();
    news.set("only", `archive:${ids.n1}`);
    news.set("back", "/inbox?folder=info");
    await expect(bulkRemoveAction(news)).rejects.toThrow(/REDIRECT/);
    expect(await unreadNewsletterCount(db, owner)).toBe(0);
    expect(await listMessages(db, owner, { folder: "info", filter: "all", page: 0 })).toEqual([]);

    // 外したメールは次の同期で戻ってこない（Gmail の履歴に出ても処理済み）
    await sync(db, owner, mail);
    expect(await inbox()).toEqual(["c1"]);
  });
});

describe("分類し直し", () => {
  it("分類に失敗したメールを分類し直しても、既読・移動・アーカイブ・返信済み・下書きありを戻さない", async () => {
    const { db, owner, mail } = await setup();
    // Claude が止まっていた：分類に失敗し、宛先だけで置いて要確認にする
    h.classify = async () => {
      throw new Error("Claude is down");
    };
    for (const [i, id] of ["read", "moved", "archived", "replied", "drafted"].entries()) {
      mail.receive({ id, threadId: `t-${id}`, from: `${id}@g.example`, to: "info@yusando.com", subject: "問合せ", date: at(i) });
    }
    await sync(db, owner, mail);
    const before = Object.fromEntries((await db.select().from(messages)).map((r) => [r.gmailMessageId, r]));
    expect(Object.values(before).every((r) => r.needsReview && r.confidence === null && r.status === "done")).toBe(true);

    // 人がしたこと
    const actions = await import("@/app/actions/mail");
    await actions.markReadAction(before.read.id);
    const move = new FormData();
    move.set("rowId", String(before.moved.id));
    move.set("folder", "cafe");
    await actions.moveFolder(move);
    const archive = new FormData();
    archive.set("only", `archive:${before.archived.id}`);
    archive.set("back", "/inbox");
    await expect(actions.bulkRemoveAction(archive)).rejects.toThrow(/REDIRECT/);
    // 返信済み・下書きあり（同僚の返信・取り込んだ下書きなどでこうなる）
    await db.update(messages).set({ status: "replied" }).where(eq(messages.id, before.replied.id));
    await db.update(messages).set({ status: "draft_ready" }).where(eq(messages.id, before.drafted.id));
    const [draft] = await db
      .insert(drafts)
      .values({ userId: owner.id, gmailThreadId: "t-drafted", replyToMessageId: "drafted", gmailDraftId: "gd1", bodyHash: "h" })
      .returning();

    // Claude が直ったので分類し直す
    h.classify = async () => classification({ category: "tour", summary: "ツアーの問合せ" });
    expect(await requeueUnclassified(db, owner)).toBe(3);
    await runJobs(db, jobHandlers(db), 10_000);

    const after = Object.fromEntries((await db.select().from(messages)).map((r) => [r.gmailMessageId, r]));
    expect(after.read).toMatchObject({ unread: false, folder: "tour", secondaryFolders: [], needsReview: false, needsReply: true, status: "new" });
    expect(after.moved).toMatchObject({ id: before.moved.id, folder: "cafe", source: "manual", needsReview: false });
    expect(after.archived).toMatchObject({ id: before.archived.id, status: "archived" });
    expect(after.replied).toMatchObject({ status: "replied", needsReply: false, unread: true });
    expect(after.drafted).toMatchObject({ status: "draft_ready", needsReply: true });
    // 下書きはそのまま。過去メールの扱いなので、新しい下書きや通知は作らない
    expect(await db.select().from(drafts)).toEqual([draft]);
    expect((await db.select().from(jobs)).filter((j) => j.kind !== "process_message")).toEqual([]);
    // 前の分類で付けた Gmail のラベル（要確認・元のフォルダ）は外れている
    expect(mail.labelNamesOf("read")).not.toContain("状態/要確認");
    expect(mail.labelNamesOf("read")).not.toContain("悠三堂/一般・取引先");
    expect(mail.labelNamesOf("read")).toEqual(expect.arrayContaining(["悠三堂/茶ツアー", "状態/要返信"]));
    expect(mail.labelNamesOf("replied")).not.toContain("状態/要返信");
    // 一覧：返信済みは要返信に数えず、下書きありは下書きに出る
    const reply = await listMessages(db, owner, { folder: null, filter: "reply", page: 0 });
    expect(reply.map((r) => r.gmailMessageId).sort()).toEqual(["drafted", "read"]);
    expect((await listMessages(db, owner, { folder: null, filter: "draft", page: 0 })).map((r) => r.gmailMessageId)).toEqual(["drafted"]);
  });
});
