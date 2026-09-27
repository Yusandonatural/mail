import { describe, expect, it } from "vitest";
import { drafts, messages } from "@/lib/db/schema";
import { generateDraft, saveDraftText } from "@/lib/drafts";
import type { DraftRequest, DraftWriter } from "@/lib/claude/drafter";
import { parseDraftOutput } from "@/lib/claude/drafter";
import { parseMessage } from "@/lib/mail/parse";
import type { CalendarApi } from "@/lib/google/calendar-api";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

class FakeDrafter implements DraftWriter {
  requests: DraftRequest[] = [];
  constructor(private body = "Hi Ben,\nPrice is 【要確認：kg単価】.\n\n─ Ryotaro") {}
  async write(req: DraftRequest) {
    this.requests.push(req);
    return { notes: "卸の新規問合せ。単価を埋めてください。", body: `${this.body} v${this.requests.length}` };
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
  const deps = { db, mail, drafter, calendar: freeCalendar, orders: null };
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

  it("茶ツアーはカレンダーの空きを候補として渡す", async () => {
    const { user, drafter, deps } = await setup("tour", "ja");
    await generateDraft(deps, user, "t1", "m1", { generatedBy: "auto" });
    expect(drafter.requests[0].slots).toHaveLength(3);
    expect(drafter.requests[0].signature).toContain("株式会社悠三堂");
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
  it("タグが無ければ全体を本文とみなす", () => {
    expect(parseDraftOutput("こんにちは")).toEqual({ notes: "", body: "こんにちは" });
  });
});
