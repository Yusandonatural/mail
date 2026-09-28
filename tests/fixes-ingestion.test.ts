import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { jobs, messages } from "@/lib/db/schema";
import { processMessage } from "@/lib/pipeline";
import { normalizeClassification, type Classifier, type ContentClassification } from "@/lib/classify/types";
import { claimNext, enqueue, failJob, PermanentJobError } from "@/lib/jobs";
import { decodeText, htmlToText, parseMessage } from "@/lib/mail/parse";
import { LabelResolver } from "@/lib/labels";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

const base: ContentClassification = {
  category: "tour",
  needs_reply: true,
  urgency: "normal",
  language: "ja",
  dates: [],
  amount: null,
  due_date: null,
  summary: "見学希望",
  accepts_proposed_time: false,
  confidence: 0.9,
};
const fixed = (over: Partial<ContentClassification> = {}): Classifier & { calls: number } => {
  const c = { calls: 0, classify: async () => (c.calls++, { ...base, ...over }) };
  return c;
};

describe("Claude の返答の正規化", () => {
  it("一覧に無い値でも失敗にせず、既知の値に寄せる", () => {
    const r = normalizeClassification({
      category: "Tea_Tour",
      needs_reply: true,
      urgency: "URGENT",
      language: "de",
      dates: [{ kind: "meeting", title: "打合せ", start: "2026-10-03T10:00:00+09:00", end: null, all_day: false, note: "" }],
      amount: null,
      due_date: "来月末",
      summary: "",
      accepts_proposed_time: false,
      confidence: 0.95,
    });
    expect(r).toMatchObject({ category: "general", urgency: "normal", language: "en", due_date: null });
    expect(r.dates[0].kind).toBe("event");
    // カテゴリが一覧外なら自信を下げて要確認に回す
    expect(r.confidence).toBeLessThan(0.7);
  });
});

describe("分類の失敗の扱い", () => {
  it("Claude の混雑（429）はジョブごとやり直し、行を作らない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "m1", from: "a@b.example", to: "isozaki@yusando.com" }));
    const err = new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers());
    const classifier: Classifier = { classify: async () => Promise.reject(err) };
    await expect(processMessage({ db, mail, classifier }, user, "m1")).rejects.toBe(err);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("Gmail のラベル付けに失敗したら DB に記録せず、再実行で最初から処理できる", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "m1", from: "a@b.example", to: "tour@yusando.com" }));
    let fail = true;
    const orig = mail.modifyMessage.bind(mail);
    mail.modifyMessage = async (...args) => {
      if (fail) throw new Error("Gmail 500");
      return orig(...args);
    };
    await expect(processMessage({ db, mail, classifier: fixed() }, user, "m1")).rejects.toThrow("Gmail 500");
    expect(await db.select().from(messages)).toHaveLength(0);
    fail = false;
    const r = await processMessage({ db, mail, classifier: fixed() }, user, "m1");
    expect(r.kind).toBe("classified");
    expect(mail.labelsAddedTo("m1")).toContain("悠三堂/茶ツアー");
  });
});

describe("返信済みのスレッド", () => {
  it("後で自分が返信していれば、要返信にしない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "in", threadId: "t", from: "a@b.example", to: "tour@yusando.com", date: new Date("2026-09-01T00:00:00Z") }),
      gmailMessage({ id: "out", threadId: "t", from: "isozaki@yusando.com", labelIds: ["SENT"], date: new Date("2026-09-02T00:00:00Z") }),
    );
    await processMessage({ db, mail, classifier: fixed() }, user, "in", { autoDraft: false });
    const [row] = await db.select().from(messages);
    expect(row).toMatchObject({ needsReply: false, status: "replied" });
    expect(mail.labelsAddedTo("in")).not.toContain("状態/要返信");
  });
});

describe("一斉配信の例外", () => {
  it("自分たちの Google グループ経由のメールは Claude で分類する", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({
        id: "g",
        from: "customer@x.example",
        to: "info@yusando.com",
        listId: "info <info.yusando.com>",
        headers: { "List-Unsubscribe": "<mailto:x>", Precedence: "list" },
      }),
    );
    const c = fixed();
    await processMessage({ db, mail, classifier: c }, user, "g", { autoDraft: false });
    expect(c.calls).toBe(1);
    const [row] = await db.select().from(messages);
    expect(row.folder).toBe("tour");
  });

  it("件名が請求書・注文などなら一斉配信でも分類する", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({
        id: "inv",
        from: "billing@saas.example",
        to: "isozaki@yusando.com",
        subject: "【請求書】2026年9月分",
        headers: { "List-Unsubscribe": "<x>" },
      }),
    );
    const c = fixed({ category: "keiri", needs_reply: false });
    await processMessage({ db, mail, classifier: c }, user, "inv");
    expect(c.calls).toBe(1);
  });
});

describe("文字コード", () => {
  it("ISO-2022-JP と Shift_JIS を正しく読む", () => {
    const jis = Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42]).toString("base64url");
    expect(decodeText(jis, "iso-2022-jp")).toBe("あ");
    expect(decodeText(Buffer.from([0x82, 0xa0]).toString("base64url"), "shift_jis")).toBe("あ");
    const msg = parseMessage({
      id: "x",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-2022-JP"' }, { name: "From", value: "a@b.c" }],
        body: { data: jis },
      },
    });
    expect(msg.text).toBe("あ");
  });

  it("範囲外の文字参照で落ちない", () => {
    expect(htmlToText("a&#x110000;b&#99999999;c")).toBe("abc");
  });
});

describe("ジョブ", () => {
  it("失敗で終わったジョブは、積み直すと再び実行される", async () => {
    const db = await testDb();
    await enqueue(db, "process_message", { a: 1 }, "k");
    const job = (await claimNext(db))!;
    await failJob(db, job, new PermanentJobError("x"));
    expect(await enqueue(db, "process_message", { a: 1 }, "k")).toBe(true);
    expect((await claimNext(db))?.id).toBe(job.id);
  });

  it("新しく届いたメールを過去メールの取り込みより先に処理する", async () => {
    const db = await testDb();
    const past = new Date(Date.now() - 60_000);
    await enqueue(db, "process_message", { messageId: "old", backfill: true }, "old", past);
    await enqueue(db, "process_message", { messageId: "new" }, "new");
    expect((await claimNext(db))?.payload).toMatchObject({ messageId: "new" });
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(2);
  });
});

describe("ラベル", () => {
  it("同時に作られて 409 になっても、既存のラベルを使う", async () => {
    const mail = new FakeMail();
    const resolver = new LabelResolver(mail);
    await resolver.id("悠三堂");
    // 別の処理が先に作った状態を再現
    mail.labels.set("悠三堂/酒", "L-other");
    mail.createLabel = async () => {
      throw new Error("409 Label name exists or conflicts");
    };
    expect(await resolver.id("悠三堂/酒")).toBe("L-other");
  });
});

describe("分類し直し", () => {
  it("分類できていないメールだけを積み直し、人が直したものは残す", async () => {
    const { requeueUnclassified, countUnclassified } = await import("@/lib/sync");
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "a@b.c", receivedAt: new Date() };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "failed", gmailThreadId: "t1", folder: "personal", source: "address", needsReview: true },
      { ...base, gmailMessageId: "manual", gmailThreadId: "t2", folder: "tour", source: "manual" },
      { ...base, gmailMessageId: "good", gmailThreadId: "t3", folder: "tour", source: "address", confidence: 0.9 },
    ]);
    expect(await countUnclassified(db, user)).toBe(1);
    expect(await requeueUnclassified(db, user)).toBe(1);
    const left = (await db.select().from(messages)).map((r) => r.gmailMessageId).sort();
    expect(left).toEqual(["good", "manual"]);
    const [job] = await db.select().from(jobs);
    expect(job.payload).toMatchObject({ messageId: "failed", backfill: true });
    expect(job.payload.removeLabels).toContain("悠三堂/個人");
    expect(job.payload.removeLabels).toContain("状態/要確認");
  });
});
