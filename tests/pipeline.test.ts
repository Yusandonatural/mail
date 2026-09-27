import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { processMessage } from "@/lib/pipeline";
import { contacts, dateCandidates, jobs, messages, rules } from "@/lib/db/schema";
import type { Classifier, ClassifierInput, ContentClassification } from "@/lib/classify/types";
import { getTableColumns } from "drizzle-orm";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

class FakeClassifier implements Classifier {
  calls: ClassifierInput[] = [];
  constructor(private result: Partial<ContentClassification> = {}) {}
  async classify(input: ClassifierInput): Promise<ContentClassification> {
    this.calls.push(input);
    return {
      category: "wholesale",
      needs_reply: true,
      urgency: "normal",
      language: "en",
      dates: [],
      amount: null,
      due_date: null,
      summary: "抹茶5kgの卸の問合せ",
      accepts_proposed_time: false,
      confidence: 0.95,
      ...this.result,
    };
  }
}

describe("受信メールの処理", () => {
  it("分類して DB に保存し、Gmail ラベルを付け、下書きジョブを積む", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "m1", from: "Ben <ben@adventcha.example>", to: "wholesale@yusando.com", text: "We want 5kg of matcha." }),
    );
    const classifier = new FakeClassifier();
    const r = await processMessage({ db, mail, classifier }, user, "m1");
    expect(r.kind).toBe("classified");

    const [row] = await db.select().from(messages);
    expect(row).toMatchObject({
      folder: "wholesale",
      category: "wholesale",
      needsReply: true,
      language: "en",
      needsReview: false,
      summary: "抹茶5kgの卸の問合せ",
      fromEmail: "ben@adventcha.example",
    });
    expect(mail.labelsAddedTo("m1")).toEqual(["悠三堂/卸売", "状態/要返信"]);
    const queued = await db.select().from(jobs);
    expect(queued.map((j) => j.kind)).toEqual(["generate_draft"]);
    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ email: "ben@adventcha.example", name: "Ben" });
  });

  it("メール本文は DB に保存しない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "m1", from: "a@b.example", to: "tour@yusando.com", text: "秘密の本文テキスト" }));
    await processMessage({ db, mail, classifier: new FakeClassifier({ category: "tour" }) }, user, "m1");
    const [row] = await db.select().from(messages);
    expect(JSON.stringify(row)).not.toContain("秘密の本文テキスト");
    expect(Object.keys(getTableColumns(messages))).not.toContain("body");
  });

  it("経理フォルダは既定で自動下書きしない。支払期日の候補を作る", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "m1", from: "請求 <billing@vendor.example>", to: "keiri@yusando.com" }));
    const classifier = new FakeClassifier({
      category: "keiri",
      needs_reply: true,
      amount: { value: 55000, currency: "JPY" },
      due_date: "2026-10-31",
      language: "ja",
    });
    await processMessage({ db, mail, classifier }, user, "m1");
    expect(await db.select().from(jobs)).toHaveLength(0);
    const [cand] = await db.select().from(dateCandidates);
    expect(cand).toMatchObject({ kind: "payment_due", start: "2026-10-31", allDay: true });
    expect(cand.title).toContain("55,000");
    const [row] = await db.select().from(messages);
    expect(row).toMatchObject({ amount: 55000, currency: "JPY", dueDate: "2026-10-31" });
  });

  it("宛先と内容が食い違えば内容を優先して要確認ラベルを付ける", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "m1", from: "a@b.example", to: "wholesale@yusando.com" }));
    await processMessage({ db, mail, classifier: new FakeClassifier({ category: "keiri", needs_reply: false }) }, user, "m1");
    const [row] = await db.select().from(messages);
    expect(row).toMatchObject({ folder: "keiri", needsReview: true, secondaryFolders: ["wholesale"] });
    expect(mail.labelsAddedTo("m1")).toEqual(["悠三堂/経理・支払・請求書", "悠三堂/卸売", "状態/要確認"]);
  });

  it("送信者ルールが info なら Claude を呼ばない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(rules).values({ kind: "domain", pattern: "newsletter.example", folder: "info" });
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "m1", from: "news@newsletter.example", to: "info@yusando.com" }));
    const classifier = new FakeClassifier();
    await processMessage({ db, mail, classifier }, user, "m1");
    expect(classifier.calls).toHaveLength(0);
    const [row] = await db.select().from(messages);
    expect(row).toMatchObject({ folder: "info", source: "domain_rule", needsReply: false });
  });

  it("迷惑メール・プロモーションは分類しない。同じメールは二度処理しない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "spam", from: "x@y.z", labelIds: ["SPAM"] }));
    mail.add(gmailMessage({ id: "ok", from: "x@y.z", to: "tour@yusando.com" }));
    const classifier = new FakeClassifier({ category: "tour" });
    expect(await processMessage({ db, mail, classifier }, user, "spam")).toEqual({ kind: "skipped", reason: "SPAM" });
    await processMessage({ db, mail, classifier }, user, "ok");
    expect(await processMessage({ db, mail, classifier }, user, "ok")).toEqual({
      kind: "skipped",
      reason: "already_processed",
    });
    expect(classifier.calls).toHaveLength(1);
  });

  it("グループ宛てで2人に届いた同じメールは分類を使い回し、自動下書きは1人分だけ", async () => {
    const db = await testDb();
    const a = await makeUser(db);
    const b = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["tour"] });
    const mailA = new FakeMail();
    const mailB = new FakeMail();
    const m = gmailMessage({ id: "x", from: "guest@t.example", to: "tour@yusando.com", messageId: "<same@t.example>" });
    mailA.add(m);
    mailB.add({ ...m, id: "y" });
    const classifier = new FakeClassifier({ category: "tour" });
    await processMessage({ db, mail: mailA, classifier }, a, "x");
    await processMessage({ db, mail: mailB, classifier }, b, "y");
    expect(classifier.calls).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(2);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("自分が送ったメールは、スレッドを対応済にする", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "in", threadId: "t1", from: "a@b.example", to: "tour@yusando.com" }));
    mail.add(gmailMessage({ id: "out", threadId: "t1", from: "isozaki@yusando.com", to: "a@b.example", labelIds: ["SENT"] }));
    await processMessage({ db, mail, classifier: new FakeClassifier({ category: "tour" }) }, user, "in");
    const r = await processMessage({ db, mail, classifier: new FakeClassifier() }, user, "out");
    expect(r.kind).toBe("reply_recorded");
    const [row] = await db.select().from(messages).where(eq(messages.gmailMessageId, "in"));
    expect(row).toMatchObject({ status: "replied", needsReply: false });
  });

  it("相手が仮予定を承諾したら、確定の提案フラグを立てる", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(dateCandidates).values({
      userId: user.id,
      gmailMessageId: "first",
      gmailThreadId: "t1",
      kind: "visit",
      title: "茶ツアー",
      start: "2026-10-03T10:00:00+09:00",
      status: "tentative",
    });
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "reply", threadId: "t1", from: "a@b.example", to: "tour@yusando.com" }));
    await processMessage(
      { db, mail, classifier: new FakeClassifier({ category: "tour", accepts_proposed_time: true, needs_reply: false }) },
      user,
      "reply",
    );
    const [row] = await db.select().from(messages);
    expect(row.suggestConfirm).toBe(true);
  });
});

describe("一斉配信", () => {
  it("個人アドレスに届いたメルマガは Claude を使わずニュースレターへ", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({
        id: "news",
        from: "mail-info@diamond.co.jp",
        to: "isozaki@yusando.com",
        headers: { "List-Unsubscribe": "<mailto:unsub@diamond.co.jp>" },
      }),
    );
    const classifier = new FakeClassifier();
    await processMessage({ db, mail, classifier }, user, "news");
    expect(classifier.calls).toHaveLength(0);
    const [row] = await db.select().from(messages);
    expect(row).toMatchObject({ folder: "info", needsReply: false, status: "done" });
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("用途別アドレス宛ての一斉配信（請求システムなど）は通常どおり分類する", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "inv", from: "billing@saas.example", to: "keiri@yusando.com", headers: { Precedence: "bulk" } }),
    );
    const classifier = new FakeClassifier({ category: "keiri", needs_reply: false });
    await processMessage({ db, mail, classifier }, user, "inv");
    expect(classifier.calls).toHaveLength(1);
    const [row] = await db.select().from(messages);
    expect(row.folder).toBe("keiri");
  });

  it("送信者ルールがあれば一斉配信でもルールに従う", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(rules).values({ kind: "domain", pattern: "jotform.com", folder: "tour" });
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "form", from: "noreply@jotform.com", to: "isozaki@yusando.com", headers: { "List-Unsubscribe": "<x>" } }),
    );
    const classifier = new FakeClassifier({ category: "tour" });
    await processMessage({ db, mail, classifier }, user, "form");
    expect(classifier.calls).toHaveLength(1);
    const [row] = await db.select().from(messages);
    expect(row.folder).toBe("tour");
  });
});

describe("消えたメッセージ", () => {
  it("Gmail に無いメッセージ（差し替えられた下書きなど）は失敗にせず飛ばす", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const r = await processMessage({ db, mail: new FakeMail(), classifier: new FakeClassifier() }, user, "gone");
    expect(r).toEqual({ kind: "skipped", reason: "not_found" });
  });
});

describe("過去メールの取り込み", () => {
  it("分類はするが下書きは自動で作らない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "old", from: "a@b.example", to: "wholesale@yusando.com" }));
    const r = await processMessage({ db, mail, classifier: new FakeClassifier() }, user, "old", { autoDraft: false });
    expect(r).toMatchObject({ kind: "classified", draftQueued: false });
    expect(await db.select().from(jobs)).toHaveLength(0);
  });
});
