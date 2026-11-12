import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeForColleagues, markRepliedLabels, processMessage } from "@/lib/pipeline";
import { drafts, jobs, messages, type User } from "@/lib/db/schema";
import { setDb, type Db } from "@/lib/db";
import { folderCounts, totalReplyCount, upcomingDues } from "@/lib/queries";
import type { Classifier, ClassifierInput, ContentClassification } from "@/lib/classify/types";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

// サーバーアクションを直接呼ぶための差し替え
const current: { user: User | null; mail: FakeMail } = { user: null, mail: new FakeMail() };
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  unstable_rethrow: () => undefined,
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => current.user }));
vi.mock("@/lib/services", () => ({
  mailFor: () => current.mail,
  draftDeps: () => {
    throw new Error("not used");
  },
  pipelineDeps: () => {
    throw new Error("not used");
  },
}));

class FakeClassifier implements Classifier {
  calls: ClassifierInput[] = [];
  constructor(private result: Partial<ContentClassification> = {}) {}
  async classify(input: ClassifierInput): Promise<ContentClassification> {
    this.calls.push(input);
    return {
      category: "tour",
      needs_reply: true,
      urgency: "normal",
      language: "ja",
      dates: [],
      amount: null,
      due_date: null,
      summary: "ツアーの問合せ",
      accepts_proposed_time: false,
      confidence: 0.9,
      ...this.result,
    };
  }
}

async function twoUsers() {
  const db = await testDb();
  const a = await makeUser(db);
  const b = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["tour"] });
  return { db, a, b };
}

const groupMail = (id: string, threadId: string) =>
  gmailMessage({ id, threadId, from: "guest@t.example", to: "tour@yusando.com", messageId: "<same@t.example>" });

const rowOf = async (db: Db, userId: number) => (await db.select().from(messages).where(eq(messages.userId, userId)))[0];

beforeEach(() => {
  current.user = null;
  current.mail = new FakeMail();
});

describe("グループ宛てのメールに誰かが返信したら、全員の要返信を外す", () => {
  it("A が返信すると B の受信箱の同じメールも対応済になり、B の Gmail ラベルはジョブで外す", async () => {
    const { db, a, b } = await twoUsers();
    const mailA = new FakeMail();
    const mailB = new FakeMail();
    mailA.add(groupMail("xa", "ta"));
    mailB.add(groupMail("xb", "tb"));
    const classifier = new FakeClassifier();
    await processMessage({ db, mail: mailA, classifier }, a, "xa");
    await processMessage({ db, mail: mailB, classifier }, b, "xb");
    expect((await rowOf(db, b.id)).status).toBe("new");

    mailA.add(
      gmailMessage({
        id: "out",
        threadId: "ta",
        from: "isozaki@yusando.com",
        to: "guest@t.example",
        labelIds: ["SENT"],
        date: new Date("2026-09-28T00:00:00Z"),
      }),
    );
    expect((await processMessage({ db, mail: mailA, classifier }, a, "out")).kind).toBe("reply_recorded");
    expect(await rowOf(db, a.id)).toMatchObject({ status: "replied", needsReply: false });
    expect(await rowOf(db, b.id)).toMatchObject({ status: "replied", needsReply: false });

    // B の Gmail は B の権限でしか変えられないので、ジョブに積む
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "mark_replied"));
    expect(job.payload).toEqual({ userId: b.id, messageId: "xb" });
    await markRepliedLabels(mailB, ["xb"]);
    const last = mailB.modifications.at(-1)!;
    expect(last.id).toBe("xb");
    expect(last.add.map((l) => mailB.labelName(l))).toEqual(["状態/対応済"]);
    expect(last.remove.map((l) => mailB.labelName(l))).toContain("状態/要返信");
  });

  it("アプリから送信したとき（markSentAction）も他の人の同じメールを閉じる", async () => {
    const { db, a, b } = await twoUsers();
    const base = { fromEmail: "guest@t.example", folder: "tour", source: "content", receivedAt: new Date(), needsReply: true };
    await db.insert(messages).values([
      { ...base, userId: a.id, gmailMessageId: "xa", gmailThreadId: "ta", rfcMessageId: "<same@t.example>", status: "draft_ready" },
      { ...base, userId: b.id, gmailMessageId: "xb", gmailThreadId: "tb", rfcMessageId: "<same@t.example>", status: "new" },
      // 別のメールは触らない
      { ...base, userId: b.id, gmailMessageId: "other", gmailThreadId: "tc", rfcMessageId: "<other@t.example>", status: "new" },
    ]);
    const [d] = await db
      .insert(drafts)
      .values({ userId: a.id, gmailThreadId: "ta", replyToMessageId: "xa", gmailDraftId: "d1", bodyHash: "h" })
      .returning();
    setDb(db);
    current.user = a;
    const { markSentAction } = await import("@/app/actions/mail");
    expect(await markSentAction(d.id)).toEqual({ ok: true });
    setDb(null);
    const rows = Object.fromEntries((await db.select().from(messages)).map((r) => [r.gmailMessageId, r.status]));
    expect(rows).toEqual({ xa: "replied", xb: "replied", other: "new" });
    expect((await db.select().from(jobs)).map((j) => j.dedupeKey)).toEqual([`replied:${b.id}:xb`]);
  });

  it("返信より後に届いたメールは、他の人の分も閉じない", async () => {
    const { db, a, b } = await twoUsers();
    const base = { fromEmail: "guest@t.example", folder: "tour", source: "content", needsReply: true, status: "new" };
    await db.insert(messages).values([
      { ...base, userId: a.id, gmailMessageId: "a2", gmailThreadId: "ta", rfcMessageId: "<later@t.example>", receivedAt: new Date("2026-10-02T00:00:00Z") },
      { ...base, userId: b.id, gmailMessageId: "b2", gmailThreadId: "tb", rfcMessageId: "<later@t.example>", receivedAt: new Date("2026-10-02T00:00:00Z") },
    ]);
    expect(await closeForColleagues(db, a, "ta", new Date("2026-10-01T00:00:00Z"))).toBe(0);
    expect((await rowOf(db, b.id)).status).toBe("new");
  });

  it("A が返信した後に B の受信箱に届いた同じメールは、返信済みとして入る", async () => {
    const { db, a, b } = await twoUsers();
    const mailA = new FakeMail();
    const mailB = new FakeMail();
    mailA.add(groupMail("xa", "ta"));
    mailA.add(
      gmailMessage({ id: "out", threadId: "ta", from: "isozaki@yusando.com", to: "guest@t.example", labelIds: ["SENT"], date: new Date("2026-09-28T00:00:00Z") }),
    );
    mailB.add(groupMail("xb", "tb"));
    const classifier = new FakeClassifier();
    await processMessage({ db, mail: mailA, classifier }, a, "xa");
    expect((await rowOf(db, a.id)).status).toBe("replied");
    await processMessage({ db, mail: mailB, classifier }, b, "xb");
    expect(classifier.calls).toHaveLength(1);
    expect(await rowOf(db, b.id)).toMatchObject({ status: "replied", needsReply: false, category: "tour" });
    expect(mailB.labelsAddedTo("xb")).toEqual(["悠三堂/茶ツアー", "状態/対応済"]);
    // B には下書きも通知も作らない
    expect((await db.select().from(jobs)).filter((j) => j.payload.userId === b.id)).toHaveLength(0);
  });

  it("A がアーカイブした行の（消えた）要返信は B に写さない", async () => {
    const { db, a, b } = await twoUsers();
    await db.insert(messages).values({
      userId: a.id,
      gmailMessageId: "xa",
      gmailThreadId: "ta",
      rfcMessageId: "<same@t.example>",
      fromEmail: "guest@t.example",
      folder: "tour",
      category: "tour",
      source: "content",
      confidence: 0.9,
      needsReply: false,
      status: "archived",
      receivedAt: new Date(),
    });
    const mailB = new FakeMail();
    mailB.add(groupMail("xb", "tb"));
    const classifier = new FakeClassifier();
    await processMessage({ db, mail: mailB, classifier }, b, "xb");
    expect(classifier.calls).toHaveLength(1);
    expect(await rowOf(db, b.id)).toMatchObject({ status: "new", needsReply: true });
  });
});

describe("分類し直しでも人が決めた状態を戻さない", () => {
  it("アーカイブ・迷惑メールは積み直さず、返信済みは返信済みのまま分類し直す", async () => {
    const { requeueUnclassified, countUnclassified } = await import("@/lib/sync");
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "guest@t.example", folder: "personal", source: "address", needsReview: true, receivedAt: new Date() };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "archived", gmailThreadId: "t1", status: "archived" },
      { ...base, gmailMessageId: "trashed", gmailThreadId: "t2", status: "skipped" },
      { ...base, gmailMessageId: "replied", gmailThreadId: "t3", status: "replied" },
      { ...base, gmailMessageId: "moved", gmailThreadId: "t4", folder: "tour", source: "manual", status: "done" },
    ]);
    expect(await countUnclassified(db, user)).toBe(1);
    expect(await requeueUnclassified(db, user)).toBe(1);
    // 行は分類し直すまで残る（一覧から消えない）
    const left = (await db.select().from(messages)).map((r) => r.gmailMessageId).sort();
    expect(left).toEqual(["archived", "moved", "replied", "trashed"]);
    const [job] = await db.select().from(jobs);
    expect(job.payload).toMatchObject({ messageId: "replied", keepStatus: "replied", reclassify: true });

    // 返信は同僚がしたので、自分の Gmail のスレッドには返信が無い。それでも要返信に戻さない
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "replied", threadId: "t3", from: "guest@t.example", to: "tour@yusando.com" }));
    await processMessage({ db, mail, classifier: new FakeClassifier() }, user, "replied", {
      autoDraft: false,
      keepStatus: "replied",
      reclassify: true,
    });
    expect(await db.select().from(messages).where(eq(messages.gmailMessageId, "replied"))).toHaveLength(1);
    const [row] = await db.select().from(messages).where(eq(messages.gmailMessageId, "replied"));
    expect(row).toMatchObject({ status: "replied", needsReply: false, folder: "tour" });
    expect(mail.labelsAddedTo("replied")).not.toContain("状態/要返信");
  });

  it("同僚が返信済みのグループ宛てメールは、分類し直しても要返信にしない", async () => {
    const { db, a, b } = await twoUsers();
    await db.insert(messages).values({
      userId: a.id,
      gmailMessageId: "xa",
      gmailThreadId: "ta",
      rfcMessageId: "<same@t.example>",
      fromEmail: "guest@t.example",
      folder: "personal",
      source: "address",
      needsReview: true,
      status: "replied",
      receivedAt: new Date(),
    });
    const mailB = new FakeMail();
    mailB.add(groupMail("xb", "tb"));
    await processMessage({ db, mail: mailB, classifier: new FakeClassifier() }, b, "xb", { autoDraft: false });
    expect(await rowOf(db, b.id)).toMatchObject({ status: "replied", needsReply: false });
  });
});

describe("アプリで迷惑メール・ゴミ箱にした後、Gmail で戻したメール", () => {
  it("一覧に出し直す（Gmail でまだゴミ箱なら何もしない）", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(messages).values({
      userId: user.id,
      gmailMessageId: "m",
      gmailThreadId: "t",
      fromEmail: "guest@t.example",
      folder: "tour",
      source: "content",
      status: "skipped",
      receivedAt: new Date(),
    });
    const mail = new FakeMail();
    const classifier = new FakeClassifier();
    mail.add(gmailMessage({ id: "m", threadId: "t", from: "guest@t.example", to: "tour@yusando.com", labelIds: ["TRASH"] }));
    expect((await processMessage({ db, mail, classifier }, user, "m")).kind).toBe("skipped");
    expect((await db.select().from(messages))[0].status).toBe("skipped");

    mail.add(gmailMessage({ id: "m", threadId: "t", from: "guest@t.example", to: "tour@yusando.com", labelIds: ["INBOX"] }));
    expect((await processMessage({ db, mail, classifier }, user, "m")).kind).toBe("classified");
    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "new", needsReply: true });
  });
});

describe("アーカイブしたメールの Gmail ラベル", () => {
  it("要返信・下書きありのラベルも外す", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const [row] = await db
      .insert(messages)
      .values({
        userId: user.id,
        gmailMessageId: "m",
        gmailThreadId: "t",
        fromEmail: "guest@t.example",
        folder: "tour",
        source: "content",
        needsReply: true,
        status: "new",
        receivedAt: new Date(),
      })
      .returning();
    const mail = current.mail;
    await mail.createLabel("状態/要返信");
    await mail.createLabel("状態/下書きあり");
    setDb(db);
    current.user = user;
    const { bulkRemoveAction } = await import("@/app/actions/mail");
    const form = new FormData();
    form.set("only", `archive:${row.id}`);
    form.set("back", "/inbox");
    await expect(bulkRemoveAction(form)).rejects.toThrow(/REDIRECT/);
    setDb(null);
    const [after] = await db.select().from(messages).where(and(eq(messages.id, row.id)));
    expect(after.status).toBe("archived");
    const mod = mail.modifications.find((m) => m.id === "m")!;
    expect(mod.remove.map((l) => mail.labelName(l) ?? l).sort()).toEqual(["INBOX", "状態/下書きあり", "状態/要返信"].sort());
  });
});

describe("今日・今週の支払期日", () => {
  it("アーカイブ・迷惑メール・ゴミ箱にしたメールは出さない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "billing@v.example", folder: "keiri", source: "content", receivedAt: new Date(), dueDate: "2026-11-20" };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "ok", gmailThreadId: "t1", status: "done" },
      { ...base, gmailMessageId: "archived", gmailThreadId: "t2", status: "archived" },
      { ...base, gmailMessageId: "trashed", gmailThreadId: "t3", status: "skipped" },
      { ...base, gmailMessageId: "far", gmailThreadId: "t4", status: "done", dueDate: "2026-12-31" },
    ]);
    const dues = await upcomingDues(db, user, "2026-11-12", "2026-11-26");
    expect(dues.map((m) => m.gmailMessageId)).toEqual(["ok"]);
  });
});

describe("左の件数はスレッドの数", () => {
  it("同じスレッドの複数のメールは1件として数え、絞り込みタブと合う", async () => {
    const { filterCounts } = await import("@/lib/queries");
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "a@b.example", folder: "tour", source: "content", receivedAt: new Date() };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "m1", gmailThreadId: "t1", needsReply: true, status: "new", needsReview: true },
      { ...base, gmailMessageId: "m2", gmailThreadId: "t1", needsReply: true, status: "new", needsReview: true },
      { ...base, gmailMessageId: "m3", gmailThreadId: "t2", needsReply: true, status: "draft_ready" },
      { ...base, gmailMessageId: "n1", gmailThreadId: "t3", folder: "info", unread: true },
      { ...base, gmailMessageId: "n2", gmailThreadId: "t3", folder: "info", unread: true },
    ]);
    const counts = await folderCounts(db, user);
    expect(counts.get("tour")).toMatchObject({ reply: 2, review: 1 });
    expect(counts.get("info")).toMatchObject({ unread: 1 });
    expect(await totalReplyCount(db, user)).toBe(2);
    expect(await filterCounts(db, user, "tour")).toMatchObject({ reply: 2, review: 1 });
  });
});

describe("3回目のまとめ直し", () => {
  it("社内の人だけに宛てた返信では、同僚の受信箱のメールは閉じない", async () => {
    const { db, a, b } = await twoUsers();
    const mailA = new FakeMail();
    const mailB = new FakeMail();
    mailA.add(groupMail("xa", "ta"));
    mailB.add(groupMail("xb", "tb"));
    const classifier = new FakeClassifier();
    await processMessage({ db, mail: mailA, classifier }, a, "xa");
    await processMessage({ db, mail: mailB, classifier }, b, "xb");
    // A が B にだけ「対応お願いします」と返信
    mailA.add(gmailMessage({ id: "sa", threadId: "ta", from: a.email, to: b.email, subject: "Re: x", labelIds: ["SENT"] }));
    await processMessage({ db, mail: mailA, classifier }, a, "sa");
    expect((await rowOf(db, a.id)).status).toBe("replied");
    expect((await rowOf(db, b.id)).status).toBe("new");
    // お客様に返信したら閉じる
    mailA.add(gmailMessage({ id: "sa2", threadId: "ta", from: a.email, to: "guest@t.example", subject: "Re: x", labelIds: ["SENT"] }));
    await processMessage({ db, mail: mailA, classifier }, a, "sa2");
    expect((await rowOf(db, b.id)).status).toBe("replied");
  });

  it("迷惑メールに指定した送信者でも、人が Gmail で戻したメールは迷惑メールに戻さない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const { rules } = await import("@/lib/db/schema");
    await db.insert(rules).values({ kind: "sender", pattern: "guest@t.example", folder: "blocked" });
    const mail = new FakeMail();
    mail.add(groupMail("x1", "t1"));
    const classifier = new FakeClassifier();
    // 1回目：ブロックで迷惑メールへ（行は作らない）。アプリで迷惑メールにした行が残っている場合を作る
    await db.insert(messages).values({
      userId: user.id,
      gmailMessageId: "x1",
      gmailThreadId: "t1",
      fromEmail: "guest@t.example",
      folder: "tour",
      source: "address",
      status: "skipped",
      receivedAt: new Date(),
    });
    const r = await processMessage({ db, mail, classifier }, user, "x1");
    expect(r.kind).toBe("classified");
    expect(mail.modifications.some((m) => m.add.includes("SPAM"))).toBe(false);
  });
});

describe("Gmail で直接返信したとき", () => {
  it("返信より前に作ったアプリの下書きを閉じ、二重に送れないようにする", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(groupMail("x1", "t1"));
    await processMessage({ db, mail, classifier: new FakeClassifier() }, user, "x1");
    await db.insert(drafts).values({ userId: user.id, gmailThreadId: "t1", replyToMessageId: "x1", gmailDraftId: "d-old", bodyHash: "h", createdAt: new Date(Date.now() - 60_000) });
    mail.add(gmailMessage({ id: "s1", threadId: "t1", from: user.email, to: "guest@t.example", subject: "Re: x", labelIds: ["SENT"], date: new Date() }));
    await processMessage({ db, mail, classifier: new FakeClassifier() }, user, "s1");
    const [d] = await db.select().from(drafts);
    expect(d.status).toBe("discarded");
    expect((await rowOf(db, user.id)).status).toBe("replied");
  });
});
