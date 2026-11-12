import { describe, expect, it } from "vitest";
import { drafts, messages } from "@/lib/db/schema";
import { adoptGmailDrafts, generateDraft, saveDraftText } from "@/lib/drafts";
import { buildMime } from "@/lib/mail/mime";
import type { DraftRequest, DraftWriter } from "@/lib/claude/drafter";
import { parseDraftOutput } from "@/lib/claude/drafter";
import { parseMessage } from "@/lib/mail/parse";
import type { CalendarApi } from "@/lib/google/calendar-api";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

class FakeDrafter implements DraftWriter {
  requests: DraftRequest[] = [];
  lookups: string[] = [];
  constructor(private body = "Hi Ben,\nPrice is 【要確認：kg単価】.\n\n─ Ryotaro") {}
  async write(req: DraftRequest) {
    this.requests.push(req);
    return { notes: "卸の新規問合せ。単価を埋めてください。", body: `${this.body} v${this.requests.length}`, lookups: this.lookups };
  }
}

const freeCalendar: CalendarApi = {
  listCalendars: async () => [],
  freeBusy: async () => [],
  listEvents: async () => [],
  insertEvent: async () => ({ id: "e1", htmlLink: null }),
  patchEvent: async () => {},
};

async function setup(category = "wholesale", language = "en") {
  const db = await testDb();
  const user = await makeUser(db);
  const mail = new FakeMail();
  mail.sendAs = [
    { email: "isozaki@yusando.com", name: "礒﨑遼太郎" },
    { email: "wholesale@yusando.com", name: "悠三堂 卸" },
  ];
  mail.add(
    gmailMessage({
      id: "m1",
      threadId: "t1",
      from: "Ben <ben@adventcha.example>",
      to: "wholesale@yusando.com",
      subject: "Matcha 5kg",
      text: "Could you quote 5kg of matcha?",
      messageId: "<m1@adventcha.example>",
    }),
  );
  await db.insert(messages).values({
    userId: user.id,
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    fromEmail: "ben@adventcha.example",
    fromName: "Ben",
    subject: "Matcha 5kg",
    folder: category,
    category,
    source: "address",
    needsReply: true,
    language,
    summary: "抹茶5kgの見積り依頼",
    receivedAt: new Date(),
  });
  const drafter = new FakeDrafter();
  const deps = { db, mail, drafter, calendar: freeCalendar, shop: null };
  return { db, user, mail, drafter, deps };
}

describe("返信下書きの生成", () => {
  it("Gmail の下書きをスレッドに作り、用途別アドレスから返信する", async () => {
    const { db, user, mail, drafter, deps } = await setup();
    const r = await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    expect(r.kind).toBe("created");
    const [d] = mail.drafts.values();
    expect(d.threadId).toBe("t1");
    expect(d.raw).toContain("To: \"Ben\" <ben@adventcha.example>");
    expect(d.raw).toContain("<wholesale@yusando.com>");
    expect(d.raw).toContain("In-Reply-To: <m1@adventcha.example>");
    expect(d.raw).toContain("Subject: Re: Matcha 5kg");
    // 英語のメールには英語の署名を渡す
    expect(drafter.requests[0].signature).toContain("Ryotaro Isozaki");
    expect(drafter.requests[0].language).toBe("en");
    const [row] = await db.select().from(messages);
    expect(row.status).toBe("draft_ready");
    expect(mail.labelsAddedTo("m1")).toContain("状態/下書きあり");
  });

  it("自動生成は、既に下書きがあれば作らない", async () => {
    const { user, mail, deps } = await setup();
    await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    const r = await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    expect(r).toEqual({ kind: "skipped", reason: "下書きが既にあります" });
    expect(mail.drafts.size).toBe(1);
  });

  it("人が触っていない下書きは再生成で差し替える", async () => {
    const { db, user, mail, deps } = await setup();
    await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    const r = await generateDraft(deps, user, "t1", "m1", { generatedBy: "manual", instruction: "もっと短く" });
    expect(r.kind).toBe("updated");
    expect(mail.drafts.size).toBe(1);
    const [row] = await db.select().from(drafts);
    expect(row).toMatchObject({ version: 2, instruction: "もっと短く" });
  });

  it("人が直した下書きは上書きせず、別案として新しい下書きを作る", async () => {
    const { user, mail, drafter, deps } = await setup();
    const first = await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    if (first.kind !== "created") throw new Error("unexpected");
    mail.editDraftBody(first.draft.gmailDraftId, "Hi Ben, 人が書き直した本文");
    const r = await generateDraft(deps, user, "t1", "m1", { generatedBy: "manual", instruction: "丁寧に" });
    expect(r).toMatchObject({ kind: "created", alternative: true });
    expect(mail.drafts.size).toBe(2);
    const original = await mail.getDraft(first.draft.gmailDraftId);
    expect(parseMessage(original!.message).text).toContain("人が書き直した本文");
    // 書き直しの指示には直前の下書きも渡す
    expect(drafter.requests[1].previousDraft).toContain("人が書き直した本文");
  });

  it("カレンダー・Shopify の調べものを渡し、調べたことをメモに残す", async () => {
    const { db, user, drafter, deps } = await setup("tour", "ja");
    drafter.lookups = ["カレンダー 2026-11-20〜2026-11-20"];
    const shop = { searchProducts: async () => "", findOrders: async () => "", policies: async () => "" };
    await generateDraft({ ...deps, shop }, user, "t1", "m1", { generatedBy: "auto" });
    const req = drafter.requests[0];
    expect(req.tools.calendar).not.toBeNull();
    expect(req.tools.shop).toBe(shop);
    expect(req.senderEmail).toBe("ben@adventcha.example");
    expect(req.signature).toContain("株式会社悠三堂");
    const [d] = await db.select().from(drafts);
    expect(d.notes).toContain("確認した情報: カレンダー 2026-11-20〜2026-11-20");
  });

  it("送る前に相手から新しいメールが届いたら、自動の下書きをそのメールに合わせて作り直す", async () => {
    const { db, user, mail, drafter, deps } = await setup();
    const first = await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    expect(first.kind).toBe("created");
    // 同じメールには作り直さない
    expect((await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" })).kind).toBe("skipped");
    mail.add(
      gmailMessage({ id: "m2", threadId: "t1", from: "Ben <ben@adventcha.example>", to: "wholesale@yusando.com", subject: "Re: Matcha 5kg", text: "Also 2kg of hojicha?" }),
    );
    const r = await generateDraft(deps, user, "t1", "m2", { generatedBy: "auto" });
    expect(r.kind).toBe("updated");
    expect(drafter.requests).toHaveLength(2);
    const [d] = await db.select().from(drafts);
    expect(d.replyToMessageId).toBe("m2");
    expect(mail.drafts.size).toBe(1);
    // もう一度動いても作り直さない
    expect((await generateDraft(deps, user, "t1", "m2", { generatedBy: "auto" })).kind).toBe("skipped");
  });

  it("画面で編集した本文を、宛先と件名を保ったまま保存する", async () => {
    const { user, mail, deps } = await setup();
    const r = await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    if (r.kind !== "created") throw new Error("unexpected");
    await saveDraftText(mail, r.draft.gmailDraftId, "t1", "Hi Ben, 12,000円/kg です。");
    const saved = await mail.getDraft(r.draft.gmailDraftId);
    const m = parseMessage(saved!.message);
    expect(m.text).toBe("Hi Ben, 12,000円/kg です。");
    expect(mail.drafts.get(r.draft.gmailDraftId)!.raw).toContain("In-Reply-To: <m1@adventcha.example>");
    expect(mail.drafts.get(r.draft.gmailDraftId)!.raw).toContain("To: \"Ben\" <ben@adventcha.example>");
  });
});

describe("Claude の出力の読み取り", () => {
  it("notes と draft のタグを取り出す", () => {
    expect(parseDraftOutput("<notes>卸。単価を確認</notes>\n<draft>\nこんにちは\n</draft>")).toEqual({
      notes: "卸。単価を確認",
      body: "こんにちは",
    });
  });
  it("<draft> が無い・閉じていない応答は本文にしない（途中経過を下書きとして保存しない）", () => {
    expect(parseDraftOutput("注文を調べます。")).toEqual({ notes: "", body: "" });
    expect(parseDraftOutput("<notes>途中</notes><draft>山田様\nご注文の件")).toEqual({ notes: "途中", body: "" });
  });
});

describe("Gmail で作られた下書きの取り込み", () => {
  const raw = buildMime({ to: [{ name: "Ben", email: "ben@adventcha.example" }], subject: "Re: Matcha 5kg", text: "Hi Ben, (Claude のスキルで作成)" });

  it("アプリが扱うスレッドの下書きだけを取り込み、下書きありにする。2回目は取り込まない", async () => {
    const { db, user, mail } = await setup();
    const ref = await mail.createDraft(raw, "t1");
    await mail.createDraft(raw, "unknown-thread");
    expect(await adoptGmailDrafts(db, mail, user)).toBe(1);
    const [d] = await db.select().from(drafts);
    expect(d).toMatchObject({ gmailDraftId: ref.draftId, gmailThreadId: "t1", replyToMessageId: "m1", generatedBy: "gmail", status: "ready" });
    const [m] = await db.select().from(messages);
    expect(m.status).toBe("draft_ready");
    expect(await adoptGmailDrafts(db, mail, user)).toBe(0);
  });

  it("Gmail に下書きが既にあれば、自動では新しく作らない", async () => {
    const { db, user, mail, drafter, deps } = await setup();
    const ref = await mail.createDraft(raw, "t1");
    mail.add(gmailMessage({ id: ref.messageId, threadId: "t1", from: "isozaki@yusando.com", text: "draft", labelIds: ["DRAFT"] }));
    const r = await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    expect(r.kind).toBe("skipped");
    expect(drafter.requests).toHaveLength(0);
    expect(mail.drafts.size).toBe(1);
    expect((await db.select().from(drafts)).map((d) => d.generatedBy)).toEqual(["gmail"]);
  });
});
