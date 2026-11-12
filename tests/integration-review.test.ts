import { describe, expect, it, vi } from "vitest";
import { generateDraft } from "@/lib/drafts";
import type { DraftRequest, DraftWriter } from "@/lib/claude/drafter";
import { contacts, messages, rules, type User } from "@/lib/db/schema";
import { setDb } from "@/lib/db";
import { BLOCK_RULE } from "@/lib/domain";
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

class Capture implements DraftWriter {
  requests: DraftRequest[] = [];
  async write(req: DraftRequest) {
    this.requests.push(req);
    return { notes: "", body: "本文" };
  }
}

describe("用途別アドレスからのメールを「自分たちのもの」とみなす判定", () => {
  it("Google グループが From を書き換えたお客様のメール（Reply-To がお客様）には返信下書きを作る", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({
        id: "g1",
        threadId: "tg",
        from: "'Guest Smith' via 茶ツアー <tour@yusando.com>",
        to: "tour@yusando.com",
        subject: "Tea tour in December",
        text: "Hello, can we visit your farm on December 5th? We are 4 people.",
        listId: "<tour.yusando.com>",
        headers: { "Reply-To": "Guest Smith <guest@example.org>" },
      }),
    );
    const drafter = new Capture();
    const r = await generateDraft({ db, mail, drafter, calendar: null, shop: null }, user, "tg", "g1", { generatedBy: "manual" });
    expect(r.kind).toBe("created");
    const req = drafter.requests[0];
    expect(req.senderEmail).toBe("guest@example.org");
    expect(req.thread.map((m) => [m.fromUs, Boolean(m.isTarget)])).toEqual([[false, true]]);
    const [d] = mail.drafts.values();
    expect(d.raw).toContain("guest@example.org");
  });

  it("別の担当者が用途別アドレスから送った返信（Reply-To 無し）は自分たちのものとして扱う", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "c1", threadId: "tc", from: "guest@example.org", to: "tour@yusando.com", text: "Can we visit?" }),
      gmailMessage({ id: "c2", threadId: "tc", from: "悠三堂 <tour@yusando.com>", to: "guest@example.org", text: "Yes!" }),
    );
    const drafter = new Capture();
    const r = await generateDraft({ db, mail, drafter, calendar: null, shop: null }, user, "tc", "c2", { generatedBy: "manual" });
    expect(r.kind).toBe("created");
    expect(drafter.requests[0].thread.map((m) => [m.fromUs, Boolean(m.isTarget)])).toEqual([
      [false, true],
      [true, false],
    ]);
  });
});

describe("返信下書きと見られないフォルダ", () => {
  it("担当者の下書きには、同じスレッドの経理のメールを渡さない（返信先にもしない）", async () => {
    const db = await testDb();
    const staff = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["tour"] });
    const base = { userId: staff.id, gmailThreadId: "th", fromEmail: "guest@example.org", source: "content", status: "new" };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "h1", folder: "tour", receivedAt: new Date("2026-11-01T00:00:00Z") },
      { ...base, gmailMessageId: "h2", folder: "keiri", receivedAt: new Date("2026-11-02T00:00:00Z") },
    ]);
    const mail = new FakeMail();
    mail.add(
      gmailMessage({ id: "h1", threadId: "th", from: "guest@example.org", to: "tour@yusando.com", text: "Tour question", date: new Date("2026-11-01T00:00:00Z") }),
      gmailMessage({ id: "h2", threadId: "th", from: "guest@example.org", to: "keiri@yusando.com", text: "Invoice: bank account 1234567", date: new Date("2026-11-02T00:00:00Z") }),
    );
    const drafter = new Capture();
    // 返信先を指定しない（自動の下書きの作り直しなど）ときも、経理のメールを返信先に選ばない
    const r = await generateDraft({ db, mail, drafter, calendar: null, shop: null }, staff, "th", null, { generatedBy: "manual" });
    expect(r.kind).toBe("created");
    const req = drafter.requests[0];
    expect(req.thread.map((m) => m.text)).toEqual(["Tour question"]);
    expect(JSON.stringify(req)).not.toContain("1234567");
  });

  it("夜間の要約（ほかの人の受信箱から作る）は担当者の下書きに渡さない", async () => {
    const db = await testDb();
    const staff = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["tour"] });
    await db.insert(contacts).values({ email: "guest@example.org", notes: "メモ", lastSummary: "請求書の未払いについて経理とやりとり中" });
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "s1", threadId: "ts", from: "guest@example.org", to: "tour@yusando.com", text: "Tour question" }));
    const drafter = new Capture();
    await generateDraft({ db, mail, drafter, calendar: null, shop: null }, staff, "ts", "s1", { generatedBy: "manual" });
    expect(drafter.requests[0]).toMatchObject({ contactNotes: "メモ", contactSummary: "" });
  });
});

describe("担当者のルールで、見られないフォルダのメールを流し込ませない", () => {
  async function setup() {
    const db = await testDb();
    const staff = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["tour"] });
    // 管理者が決めたルール：bank.example からのメールは経理へ
    await db.insert(rules).values({ kind: "domain", pattern: "bank.example", folder: "keiri" });
    // tour@ にも宛てられていたので、副ラベルで担当者にも見えている
    const [row] = await db
      .insert(messages)
      .values({
        userId: staff.id,
        gmailMessageId: "b1",
        gmailThreadId: "tb",
        fromEmail: "alice@mail.bank.example",
        folder: "keiri",
        secondaryFolders: ["tour"],
        source: "domain_rule",
        status: "new",
        receivedAt: new Date(),
      })
      .returning();
    current.user = staff;
    current.mail = new FakeMail();
    current.mail.add(gmailMessage({ id: "b1", threadId: "tb", from: "alice@mail.bank.example", to: "tour@yusando.com" }));
    setDb(db);
    return { db, row };
  }

  it.each(["sender", "domain"])("「今後も」（%s）で、経理へのドメインのルールより強いルールを作らせない", async (remember) => {
    const { db, row } = await setup();
    const { moveFolder } = await import("@/app/actions/mail");
    const form = new FormData();
    form.set("rowId", String(row.id));
    form.set("folder", "tour");
    form.set("remember", remember);
    await expect(moveFolder(form)).rejects.toThrow(new RegExp(`REDIRECT:/m/${row.id}\\?notice=`));
    setDb(null);
    expect((await db.select().from(rules)).map((r) => r.pattern)).toEqual(["bank.example"]);
  });

  it("迷惑メールの「今後も」で、経理へのルールがある送信者を全員分ブロックさせない", async () => {
    const { db, row } = await setup();
    const { bulkRemoveAction } = await import("@/app/actions/mail");
    const form = new FormData();
    form.set("only", `spam:${row.id}`);
    form.set("block", "1");
    form.set("back", "/inbox");
    await expect(bulkRemoveAction(form)).rejects.toThrow(/REDIRECT/);
    setDb(null);
    expect((await db.select().from(rules)).filter((r) => r.folder === BLOCK_RULE)).toEqual([]);
  });
});
