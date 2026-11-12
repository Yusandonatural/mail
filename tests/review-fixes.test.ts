import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { processMessage } from "@/lib/pipeline";
import { messages } from "@/lib/db/schema";
import { listMessages, threadRowsOf } from "@/lib/queries";
import { LabelResolver } from "@/lib/labels";
import type { Classifier, ContentClassification } from "@/lib/classify/types";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

const needsReply = (): Classifier => ({
  async classify(): Promise<ContentClassification> {
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
      confidence: 0.95,
    };
  },
});

const day = (d: number) => new Date(`2026-09-${String(d).padStart(2, "0")}T00:00:00Z`);

describe("自分の返信の記録", () => {
  it("返信より後に届いたメールは、新しいメールが先に処理されても要返信のまま", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "c1", threadId: "t", from: "a@b.example", to: "tour@yusando.com", date: day(1) }),
      gmailMessage({ id: "s1", threadId: "t", from: "isozaki@yusando.com", to: "a@b.example", labelIds: ["SENT"], date: day(2) }),
      gmailMessage({ id: "c2", threadId: "t", from: "a@b.example", to: "tour@yusando.com", date: day(3) }),
    );
    const deps = { db, mail, classifier: needsReply() };
    // 取り込み（新しい順）：c2 → s1 → c1
    await processMessage(deps, user, "c2", { autoDraft: false });
    await processMessage(deps, user, "s1", { autoDraft: false });
    await processMessage(deps, user, "c1", { autoDraft: false });
    const [c2] = await db.select().from(messages).where(eq(messages.gmailMessageId, "c2"));
    const [c1] = await db.select().from(messages).where(eq(messages.gmailMessageId, "c1"));
    expect(c2).toMatchObject({ needsReply: true, status: "new" });
    expect(c1).toMatchObject({ needsReply: false, status: "replied" });
    // 「対応済」は返信より前のメールだけに付ける
    expect(mail.modifications.some((m) => m.id === "c2" && m.add.includes(mail.labels.get("状態/対応済")!))).toBe(false);
  });

  it("社内への転送は返信として扱わない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "c1", threadId: "t", from: "a@b.example", to: "tour@yusando.com", date: day(1) }),
      gmailMessage({
        id: "f1",
        threadId: "t",
        from: "isozaki@yusando.com",
        to: "staff@yusando.com",
        subject: "Fwd: ツアーの問合せ",
        labelIds: ["SENT"],
        date: day(2),
      }),
    );
    const deps = { db, mail, classifier: needsReply() };
    await processMessage(deps, user, "c1", { autoDraft: false });
    const r = await processMessage(deps, user, "f1", { autoDraft: false });
    expect(r.kind).toBe("skipped");
    const [c1] = await db.select().from(messages);
    expect(c1).toMatchObject({ needsReply: true, status: "new" });
  });

  it("自分の下書きは返信として扱わない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "c1", threadId: "t", from: "a@b.example", to: "tour@yusando.com", date: day(1) }),
      gmailMessage({ id: "d1", threadId: "t", from: "isozaki@yusando.com", labelIds: ["DRAFT"], date: day(2) }),
    );
    const deps = { db, mail, classifier: needsReply() };
    await processMessage(deps, user, "c1", { autoDraft: false });
    expect((await processMessage(deps, user, "d1")).kind).toBe("skipped");
    const [c1] = await db.select().from(messages);
    expect(c1).toMatchObject({ needsReply: true, status: "new" });
  });
});

describe("スレッドの一覧", () => {
  const base = { fromEmail: "a@b.c", source: "address", folder: "tour" };

  it("最新のメールが要返信でなくても、スレッドに要返信があれば行に出す", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(messages).values([
      { ...base, userId: user.id, gmailMessageId: "q", gmailThreadId: "t", needsReply: true, status: "new", urgency: "high", receivedAt: day(1) },
      { ...base, userId: user.id, gmailMessageId: "ps", gmailThreadId: "t", needsReply: false, status: "done", receivedAt: day(2) },
      { ...base, userId: user.id, gmailMessageId: "x", gmailThreadId: "u", needsReply: false, status: "done", receivedAt: day(3) },
    ]);
    const rows = await listMessages(db, user, { folder: null, filter: "all", page: 0 });
    expect(rows.map((r) => [r.gmailMessageId, r.threadOpen, r.threadUrgent, r.threadDraft])).toEqual([
      ["x", false, false, false],
      ["ps", true, true, false],
    ]);
  });

  it("行の操作はスレッドの全メール（見られるもの・外していないもの）に広げる", async () => {
    const db = await testDb();
    const staff = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["tour"] });
    const inserted = await db
      .insert(messages)
      .values([
        { ...base, userId: staff.id, gmailMessageId: "a1", gmailThreadId: "t", receivedAt: day(1) },
        { ...base, userId: staff.id, gmailMessageId: "a2", gmailThreadId: "t", receivedAt: day(2) },
        { ...base, userId: staff.id, gmailMessageId: "k", gmailThreadId: "t", folder: "keiri", receivedAt: day(2) },
        { ...base, userId: staff.id, gmailMessageId: "gone", gmailThreadId: "t", status: "skipped", receivedAt: day(2) },
        { ...base, userId: staff.id, gmailMessageId: "other", gmailThreadId: "u", receivedAt: day(3) },
      ])
      .returning();
    const latest = inserted.find((r) => r.gmailMessageId === "a2")!;
    const rows = await threadRowsOf(db, staff, [latest]);
    expect(rows.map((r) => r.gmailMessageId).sort()).toEqual(["a1", "a2"]);
  });
});

describe("ラベル", () => {
  it("親ラベルを作るときに一覧を取り直しても、作った子ラベルを覚えている", async () => {
    const mail = new FakeMail();
    let calls = 0;
    const create = mail.createLabel.bind(mail);
    mail.createLabel = async (name: string) => {
      calls++;
      // 親ラベルは別の処理が先に作っていた（409）
      if (name === "状態") {
        await create(name);
        throw new Error("409");
      }
      return create(name);
    };
    const labels = new LabelResolver(mail);
    const id = await labels.id("状態/要返信");
    expect(await labels.existingId("状態/要返信")).toBe(id);
    expect(calls).toBe(2);
  });
});

describe("アドレスの解析", () => {
  it("「addr (名前)」形式の括弧をアドレスに混ぜない", async () => {
    const { parseAddressList } = await import("@/lib/mail/parse");
    expect(parseAddressList("Taro@Example.jp (山田 太郎), b@c.d")).toEqual([
      { name: "山田 太郎", email: "taro@example.jp" },
      { name: null, email: "b@c.d" },
    ]);
  });
});

describe("履歴切れからの復旧", () => {
  it("最後に取り込んだメール以降を拾い直し、2日より前の分は過去メールとして積む", async () => {
    const { syncUser } = await import("@/lib/sync");
    const { HistoryExpiredError } = await import("@/lib/google/mail-api");
    const { jobs } = await import("@/lib/db/schema");
    const db = await testDb();
    const user = await makeUser(db, { historyId: "1" });
    await db.insert(messages).values({
      userId: user.id,
      gmailMessageId: "last",
      gmailThreadId: "t",
      fromEmail: "x@y.z",
      folder: "general",
      source: "address",
      receivedAt: new Date(Date.now() - 10 * 86_400_000),
    });
    const mail = new FakeMail();
    const queries: string[] = [];
    mail.listHistory = async () => {
      throw new HistoryExpiredError();
    };
    (mail as unknown as { listMessageIds: (q: string) => Promise<string[]> }).listMessageIds = async (q: string) => {
      queries.push(q);
      return q.startsWith("newer_than:2d") ? ["new1"] : ["new1", "old1", "old2"];
    };
    expect(await syncUser(db, mail, user)).toBe(3);
    expect(queries[0]).toBe("newer_than:2d -in:drafts");
    // 10日前のメール以降（端数の切り上げと1日の余裕を含む）
    expect(queries[1]).toMatch(/^newer_than:1[12]d -in:drafts$/);
    expect(queries).toHaveLength(2);
    const queued = await db.select().from(jobs);
    expect(queued.map((j) => [j.payload.messageId, Boolean(j.payload.backfill)])).toEqual([
      ["new1", false],
      ["old1", true],
      ["old2", true],
    ]);
  });
});

describe("迷惑メールから戻したメール", () => {
  it("届いたときは迷惑メールで飛ばしたメールも、Gmail で戻されたら処理し直す", async () => {
    const { syncUser } = await import("@/lib/sync");
    const { claimNext } = await import("@/lib/jobs");
    const db = await testDb();
    const user = await makeUser(db, { historyId: "1" });
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "s", threadId: "t", from: "a@b.example", to: "tour@yusando.com", labelIds: ["SPAM"] }));
    mail.historyIds = ["s"];
    await syncUser(db, mail, user);
    const deps = { db, mail, classifier: needsReply() };
    const job = await claimNext(db);
    expect((await processMessage(deps, user, String(job!.payload.messageId))).kind).toBe("skipped");
    const { finishJob } = await import("@/lib/jobs");
    await finishJob(db, job!.id);
    // 人が Gmail で「迷惑メールではない」にした
    mail.add(gmailMessage({ id: "s", threadId: "t", from: "a@b.example", to: "tour@yusando.com", labelIds: ["INBOX"] }));
    mail.historyIds = [];
    mail.restoredIds = ["s"];
    const [u] = await db.select().from((await import("@/lib/db/schema")).users);
    expect(await syncUser(db, mail, u)).toBe(1);
    const again = await claimNext(db);
    expect(again?.payload.messageId).toBe("s");
    expect((await processMessage(deps, user, "s")).kind).toBe("classified");
  });
});
