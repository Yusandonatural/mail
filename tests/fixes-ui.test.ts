import { describe, expect, it } from "vitest";
import { messages, pushSubscriptions } from "@/lib/db/schema";
import { filterCounts, listMessages, safeBack, totalReplyCount } from "@/lib/queries";
import { claudeFailing } from "@/lib/settings";
import { dayGroupLabel, formatListTime } from "@/lib/time";
import { saveDraftText } from "@/lib/drafts";
import { buildMime } from "@/lib/mail/mime";
import { notifyUser } from "@/lib/notify";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail } from "./helpers/fake-mail";

describe("受信箱", () => {
  it("ニュースレター以外の全フォルダを出し、スレッドごとに1行・最新のメールが上", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "a@b.c", source: "address", needsReply: true, status: "new" };
    const at = (d: string) => new Date(`2026-11-${d}T00:00:00Z`);
    await db.insert(messages).values([
      { ...base, gmailMessageId: "news", gmailThreadId: "t1", folder: "info", receivedAt: at("12"), needsReply: false },
      { ...base, gmailMessageId: "tour", gmailThreadId: "t2", folder: "personal", secondaryFolders: ["tour"], receivedAt: at("09") },
      { ...base, gmailMessageId: "sale-1", gmailThreadId: "t3", folder: "wholesale", receivedAt: at("01"), unread: true },
      // 古いスレッドに今日返信が来た：その返信の行がいちばん上に来る
      { ...base, gmailMessageId: "sale-2", gmailThreadId: "t3", folder: "wholesale", receivedAt: at("11"), unread: false },
      { ...base, gmailMessageId: "plain", gmailThreadId: "t5", folder: "personal", receivedAt: at("10") },
    ]);
    const rows = await listMessages(db, user, { folder: null, filter: "all", page: 0 });
    expect(rows.map((r) => r.gmailMessageId)).toEqual(["sale-2", "plain", "tour"]);
    expect(rows[0]).toMatchObject({ threadCount: 2, threadUnread: true });
    expect(await totalReplyCount(db, user)).toBe(4);
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

describe("絞り込み", () => {
  it("下書きは全フォルダから出し、件数はスレッドで数える", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const base = { userId: user.id, fromEmail: "a@b.c", source: "address", receivedAt: new Date(), needsReply: true };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "tour-draft", gmailThreadId: "t1", folder: "tour", status: "draft_ready" },
      { ...base, gmailMessageId: "personal-draft", gmailThreadId: "t2", folder: "personal", status: "draft_ready" },
      { ...base, gmailMessageId: "personal-new", gmailThreadId: "t3", folder: "personal", status: "new", needsReview: true },
      { ...base, gmailMessageId: "news-draft", gmailThreadId: "t4", folder: "info", status: "draft_ready" },
    ]);
    const drafts = await listMessages(db, user, { folder: null, filter: "draft", page: 0 });
    expect(drafts.map((r) => r.gmailMessageId).sort()).toEqual(["personal-draft", "tour-draft"]);
    expect(await filterCounts(db, user, null)).toEqual({ reply: 3, draft: 2, review: 1 });
  });
});

describe("Claude の接続", () => {
  it("失敗のあと成功するまで、失敗の理由を出す", () => {
    expect(claudeFailing({ lastError: null, lastErrorAt: null, lastOkAt: null })).toBeNull();
    expect(claudeFailing({ lastError: "キーが違う", lastErrorAt: "2026-11-12T01:00:00Z", lastOkAt: "2026-11-11T00:00:00Z" })).toBe("キーが違う");
    expect(claudeFailing({ lastError: "キーが違う", lastErrorAt: "2026-11-12T01:00:00Z", lastOkAt: "2026-11-12T02:00:00Z" })).toBeNull();
  });
});

describe("一覧の時刻と見出し", () => {
  it("今日は時刻、昨日・曜日・日付の順に粗くする", () => {
    const now = new Date("2026-11-12T03:00:00Z"); // 日本時間 12日 12:00
    expect(formatListTime(new Date("2026-11-12T00:05:00Z"), now)).toBe("9:05");
    expect(formatListTime(new Date("2026-11-11T05:00:00Z"), now)).toBe("昨日");
    expect(formatListTime(new Date("2026-11-08T05:00:00Z"), now)).toBe("日曜");
    expect(formatListTime(new Date("2026-10-01T05:00:00Z"), now)).toBe("10/1");
    expect(dayGroupLabel(new Date("2026-11-11T16:00:00Z"), now)).toBe("今日"); // 日本時間 12日 1:00
    expect(dayGroupLabel(new Date("2026-11-11T05:00:00Z"), now)).toBe("昨日");
    expect(dayGroupLabel(new Date("2026-11-08T05:00:00Z"), now)).toBe("この1週間");
    expect(dayGroupLabel(new Date("2026-10-01T05:00:00Z"), now)).toBe("10月");
  });
});
