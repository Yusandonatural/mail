import { describe, expect, it } from "vitest";
import { messages, pushSubscriptions } from "@/lib/db/schema";
import { listMessages, safeBack, totalReplyCount } from "@/lib/queries";
import { saveDraftText } from "@/lib/drafts";
import { buildMime } from "@/lib/mail/mime";
import { notifyUser } from "@/lib/notify";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail } from "./helpers/fake-mail";

describe("受信箱（全て）", () => {
  it("振り分け前のメールと要確認だけを出し、振り分け済み・ニュースレターは各フォルダだけに出す", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "a@b.c", source: "address", receivedAt: new Date(), needsReply: true, status: "new" };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "news", gmailThreadId: "t1", folder: "info", needsReply: false },
      { ...base, gmailMessageId: "tour", gmailThreadId: "t2", folder: "personal", secondaryFolders: ["tour", "press"] },
      { ...base, gmailMessageId: "sale", gmailThreadId: "t3", folder: "wholesale" },
      { ...base, gmailMessageId: "unsure", gmailThreadId: "t4", folder: "cafe", needsReview: true },
      { ...base, gmailMessageId: "plain", gmailThreadId: "t5", folder: "personal" },
    ]);
    const rows = await listMessages(db, user, { folder: null, filter: "all", page: 0 });
    expect(rows.map((r) => r.gmailMessageId).sort()).toEqual(["plain", "unsure"]);
    expect(await totalReplyCount(db, user)).toBe(2);
    const tour = await listMessages(db, user, { folder: "tour", filter: "all", page: 0 });
    expect(tour.map((r) => r.gmailMessageId)).toEqual(["tour"]);
    const info = await listMessages(db, user, { folder: "info", filter: "all", page: 0 });
    expect(info.map((r) => r.gmailMessageId)).toEqual(["news"]);
  });

  it("戻り先はアプリ内の一覧だけを許す", () => {
    expect(safeBack("/inbox?folder=tour&filter=reply")).toBe("/inbox?folder=tour&filter=reply");
    expect(safeBack("/search?q=abc")).toBe("/search?q=abc");
    expect(safeBack("https://evil.example")).toBe("/inbox");
    expect(safeBack("//evil.example")).toBe("/inbox");
    expect(safeBack(undefined)).toBe("/inbox");
  });
});

describe("送信前の保存", () => {
  it("本文が変わっていなければ Gmail の下書きを作り直さない", async () => {
    const mail = new FakeMail();
    const raw = buildMime({ to: [{ name: null, email: "a@b.c" }], subject: "Re: x", text: "こんにちは\n\n署名" });
    const ref = await mail.createDraft(raw, "t");
    let updated = 0;
    const orig = mail.updateDraft.bind(mail);
    mail.updateDraft = async (...a) => (updated++, orig(...a));
    await saveDraftText(mail, ref.draftId, "t", "こんにちは\n\n署名\n");
    expect(updated).toBe(0);
    await saveDraftText(mail, ref.draftId, "t", "書き直した本文");
    expect(updated).toBe(1);
  });
});

describe("通知", () => {
  it("1台で失敗しても、ほかの端末には送る", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(pushSubscriptions).values([
      { userId: user.id, endpoint: "https://p/broken", p256dh: "k", auth: "a" },
      { userId: user.id, endpoint: "https://p/ok", p256dh: "k", auth: "a" },
    ]);
    const n = await notifyUser(
      db,
      {
        send: async (sub) => {
          if (sub.endpoint.endsWith("broken")) throw new Error("500");
          return "ok";
        },
      },
      user.id,
      { title: "t", body: "b", url: "/", tag: "x" },
    );
    expect(n).toBe(1);
  });
});

describe("一覧の並び順", () => {
  it("至急かどうかに関係なく、新しく届いた順に並べる", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "a@b.c", source: "address", folder: "tour", needsReply: true, status: "new" };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "old-urgent", gmailThreadId: "t1", urgency: "high", receivedAt: new Date("2026-09-01T00:00:00Z") },
      { ...base, gmailMessageId: "new-normal", gmailThreadId: "t2", urgency: "normal", receivedAt: new Date("2026-09-20T00:00:00Z") },
    ]);
    const rows = await listMessages(db, user, { folder: "tour", filter: "all", page: 0 });
    expect(rows.map((r) => r.gmailMessageId)).toEqual(["new-normal", "old-urgent"]);
  });
});
