import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { drafts, messages, rules, users } from "@/lib/db/schema";
import { adoptGmailDrafts, generateDraft } from "@/lib/drafts";
import type { DraftWriter } from "@/lib/claude/drafter";
import { BLOCK_RULE } from "@/lib/domain";
import { processMessage } from "@/lib/pipeline";
import { syncUser } from "@/lib/sync";
import type { Classifier, ContentClassification } from "@/lib/classify/types";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

const classification: ContentClassification = {
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
};

describe("迷惑メールに指定した送信者のメールを、人が Gmail で戻したとき", () => {
  it("1回目の分類が混雑で失敗してやり直しても、迷惑メールへ戻さない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(rules).values({ kind: "sender", pattern: "guest@t.example", folder: BLOCK_RULE });
    // アプリで迷惑メールにした行（skipped）。人が Gmail の迷惑メールから受信トレイに戻した
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
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "x1", threadId: "t1", from: "guest@t.example", to: "tour@yusando.com" }));
    let busy = true;
    const classifier: Classifier = {
      classify: async () => {
        if (busy) throw new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers());
        return classification;
      },
    };
    await expect(processMessage({ db, mail, classifier }, user, "x1")).rejects.toThrow();
    // やり直すまで、一覧から外れたまま（skipped の行が残る）で、消えてはいない
    expect((await db.select().from(messages))[0].status).toBe("skipped");

    busy = false;
    const r = await processMessage({ db, mail, classifier }, user, "x1");
    expect(r.kind).toBe("classified");
    expect(mail.modifications.some((m) => m.add.includes("SPAM"))).toBe(false);
    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "new", needsReply: true });
  });
});

describe("Gmail の履歴の同期", () => {
  it("Gmail を呼ぶ間はトランザクション（利用者の行のロック）を持たない", async () => {
    const db = await testDb();
    const user = await makeUser(db, { historyId: "1" });
    const mail = new FakeMail();
    const day = new Date("2026-09-01T00:00:00Z");
    for (const [id, status] of [
      ["open", "new"],
      ["arc", "archived"],
    ] as const) {
      mail.add(gmailMessage({ id, threadId: `t-${id}`, from: "a@b.example", date: day }));
      await db.insert(messages).values({
        userId: user.id,
        gmailMessageId: id,
        gmailThreadId: `t-${id}`,
        fromEmail: "a@b.example",
        folder: "general",
        source: "address",
        receivedAt: day,
        status,
        needsReply: status === "new",
      });
    }
    mail.historyIds = [];
    // 人が Gmail で、要返信のメールをアーカイブし、アーカイブ済みのメールを受信トレイに戻した
    mail.change("open", [], ["INBOX"]);
    mail.change("arc", ["INBOX"], []);

    // Gmail を呼んでいる間に、ほかの処理（push と cron の同時実行など）が DB を使えるか
    const blocked: string[] = [];
    const probe = async (name: string) => {
      const ok = await Promise.race([
        db.execute(sql`select 1`).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      if (!ok) blocked.push(name);
    };
    const getThread = mail.getThread.bind(mail);
    mail.getThread = async (id) => {
      await probe(`getThread ${id}`);
      return getThread(id);
    };
    const modifyMessage = mail.modifyMessage.bind(mail);
    mail.modifyMessage = async (id, add, remove) => {
      await probe(`modifyMessage ${id}`);
      return modifyMessage(id, add, remove);
    };

    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    await syncUser(db, mail, u);
    expect(blocked).toEqual([]);
    const row = async (id: string) => (await db.select().from(messages).where(eq(messages.gmailMessageId, id)))[0];
    // Gmail でのアーカイブはスヌーズと区別できないので、要返信は残してラベルにも触らない
    expect(await row("open")).toMatchObject({ status: "archived", needsReply: true });
    expect((await row("arc")).status).toBe("done");
    expect(mail.modifications.some((m) => m.id === "open" && !m.thread && m.add.length > 0)).toBe(false);
    expect((await db.select({ h: users.historyId }).from(users))[0].h).toBe("200");
  });
});

describe("下書きの生成と、Gmail の下書きの取り込みが重なったとき", () => {
  it("取り込みが先に記録しても失敗せず、アプリの下書き（メモ付き）として1行だけ残す", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "m1", threadId: "t1", from: "Ben <ben@adventcha.example>", to: "wholesale@yusando.com" }));
    await db.insert(messages).values({
      userId: user.id,
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      fromEmail: "ben@adventcha.example",
      folder: "wholesale",
      category: "wholesale",
      source: "address",
      needsReply: true,
      language: "en",
      receivedAt: new Date(),
    });
    // Gmail に下書きを作った直後、記録する前に cron の取り込みが走る
    const createDraft = mail.createDraft.bind(mail);
    mail.createDraft = async (raw, threadId) => {
      const ref = await createDraft(raw, threadId);
      await adoptGmailDrafts(db, mail, user);
      return ref;
    };
    const drafter: DraftWriter = { write: async () => ({ notes: "卸の問合せ", body: "Hi Ben,\nThanks.", lookups: [] }) };
    const r = await generateDraft({ db, mail, drafter, calendar: null, shop: null }, user, "t1", "m1", { generatedBy: "auto" });
    expect(r.kind).toBe("created");
    const rows = await db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ generatedBy: "auto", notes: "卸の問合せ", status: "ready" });
    expect((await db.select().from(messages))[0].status).toBe("draft_ready");
  });
});

