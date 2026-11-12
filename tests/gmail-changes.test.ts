import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, messages, users, type User } from "@/lib/db/schema";
import type { Db } from "@/lib/db";
import { STATUS_LABELS } from "@/lib/domain";
import { summarizeHistory } from "@/lib/google/mail-api";
import { claimNext } from "@/lib/jobs";
import { processMessage } from "@/lib/pipeline";
import { syncUser } from "@/lib/sync";
import type { Classifier, ContentClassification } from "@/lib/classify/types";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

const day = (d: number) => new Date(`2026-09-${String(d).padStart(2, "0")}T00:00:00Z`);

interface Seed {
  id: string;
  threadId?: string;
  labelIds?: string[];
  status?: string;
  needsReply?: boolean;
  unread?: boolean;
}

/** Gmail にメールを置き、取り込み済みの行も作る */
async function setup(rows: Seed[]) {
  const db = await testDb();
  const user = await makeUser(db, { historyId: "1" });
  const mail = new FakeMail();
  for (const r of rows) {
    const threadId = r.threadId ?? `t-${r.id}`;
    mail.add(gmailMessage({ id: r.id, threadId, from: "a@b.example", labelIds: r.labelIds, date: day(1) }));
    await db.insert(messages).values({
      userId: user.id,
      gmailMessageId: r.id,
      gmailThreadId: threadId,
      fromEmail: "a@b.example",
      folder: "general",
      source: "address",
      receivedAt: day(1),
      status: r.status ?? "new",
      needsReply: r.needsReply ?? false,
      unread: r.unread ?? true,
    });
  }
  // 取り込みは済んでいるので、届いたメールとしては積まない
  mail.historyIds = [];
  return { db, user, mail };
}

async function sync(db: Db, mail: FakeMail, user: User) {
  const [u] = await db.select().from(users).where(eq(users.id, user.id));
  const n = await syncUser(db, mail, u);
  mail.history = [];
  return n;
}

async function row(db: Db, id: string) {
  const [r] = await db.select().from(messages).where(eq(messages.gmailMessageId, id));
  return r;
}

describe("Gmail で直接行った操作の反映", () => {
  it("Gmail でアーカイブしたメールはアーカイブにし、Gmail の要返信も外す", async () => {
    const { db, user, mail } = await setup([
      { id: "a", status: "new", needsReply: true },
      { id: "n", status: "done" },
    ]);
    mail.change("a", [], ["INBOX"]);
    mail.change("n", [], ["INBOX"]);
    await sync(db, mail, user);
    expect(await row(db, "a")).toMatchObject({ status: "archived", needsReply: false });
    expect(await row(db, "n")).toMatchObject({ status: "archived" });
    // 要返信だった行だけ、アプリのアーカイブと同じく対応済のラベルを付ける
    expect(mail.labelsAddedTo("a")).toContain(STATUS_LABELS.done);
    expect(mail.labelsAddedTo("n")).toEqual([]);
  });

  it("受信トレイに無かったメール（受信トレイをスキップ）や、迷惑メール・ゴミ箱の行はアーカイブにしない", async () => {
    const { db, user, mail } = await setup([
      { id: "filtered", labelIds: ["UNREAD", "Label_1"], status: "done" },
      { id: "spam", status: "skipped" },
    ]);
    // 受信トレイに無かったメールはラベルを変えても INBOX が外れる履歴は来ない
    mail.change("filtered", [], ["UNREAD"]);
    mail.change("spam", [], ["INBOX"]);
    await sync(db, mail, user);
    expect(await row(db, "filtered")).toMatchObject({ status: "done", unread: false });
    expect((await row(db, "spam")).status).toBe("skipped");
  });

  it("アプリでアーカイブ・迷惑メール・ゴミ箱にした後に同じ履歴が届いても何も変わらない", async () => {
    const { db, user, mail } = await setup([
      { id: "arc", status: "archived", unread: false },
      { id: "sp", status: "skipped", unread: false },
      { id: "tr", status: "skipped", unread: false },
    ]);
    // removeRows と同じ Gmail の操作（DB は既に archived / skipped）
    await mail.modifyMessage("arc", ["L-done"], ["INBOX"]);
    await mail.modifyMessage("sp", ["SPAM"], ["INBOX", "UNREAD"]);
    await mail.trashMessage("tr");
    const before = mail.modifications.length;
    await sync(db, mail, user);
    expect(await row(db, "arc")).toMatchObject({ status: "archived", unread: false });
    expect((await row(db, "sp")).status).toBe("skipped");
    expect((await row(db, "tr")).status).toBe("skipped");
    // ラベルを付け直したりしない
    expect(mail.modifications).toHaveLength(before);
    expect(await db.select().from(jobs)).toHaveLength(0);
    // 2回目の同期でも同じ
    await mail.modifyMessage("arc", ["L-done"], ["INBOX"]);
    await sync(db, mail, user);
    expect((await row(db, "arc")).status).toBe("archived");
  });

  it("Gmail で受信トレイに戻したアーカイブ済みのメールは、要返信に戻さず一覧に戻す", async () => {
    const { db, user, mail } = await setup([
      { id: "plain", labelIds: [], status: "archived" },
      { id: "answered", threadId: "t2", labelIds: [], status: "archived" },
      { id: "visible", status: "done" },
    ]);
    // answered のスレッドには、このメールより後に自分の返信がある
    mail.add(gmailMessage({ id: "sent", threadId: "t2", from: "isozaki@yusando.com", labelIds: ["SENT"], date: day(2) }));
    mail.change("plain", ["INBOX"], []);
    mail.change("answered", ["INBOX"], []);
    mail.change("visible", ["INBOX"], []);
    await sync(db, mail, user);
    expect(await row(db, "plain")).toMatchObject({ status: "done", needsReply: false });
    expect(await row(db, "answered")).toMatchObject({ status: "replied", needsReply: false });
    expect((await row(db, "visible")).status).toBe("done");
  });

  it("Gmail でゴミ箱・迷惑メールにしたメールは一覧から外し、戻されたら処理し直す", async () => {
    const { db, user, mail } = await setup([
      { id: "t", status: "new", needsReply: true },
      { id: "s", status: "archived" },
    ]);
    mail.change("t", ["TRASH"], []);
    mail.change("s", ["SPAM"], ["INBOX"]);
    await sync(db, mail, user);
    expect(await row(db, "t")).toMatchObject({ status: "skipped", needsReply: false, unread: false });
    expect((await row(db, "s")).status).toBe("skipped");
    expect(await db.select().from(jobs)).toHaveLength(0);

    // ゴミ箱から戻した：今までどおり処理し直す
    mail.change("t", [], ["TRASH"]);
    expect(await sync(db, mail, user)).toBe(1);
    const job = await claimNext(db);
    expect(job?.payload.messageId).toBe("t");
    const classifier: Classifier = {
      async classify(): Promise<ContentClassification> {
        return {
          category: "general",
          needs_reply: false,
          urgency: "normal",
          language: "ja",
          dates: [],
          amount: null,
          due_date: null,
          summary: "お知らせ",
          accepts_proposed_time: false,
          confidence: 0.9,
        };
      },
    };
    expect((await processMessage({ db, mail, classifier }, user, "t")).kind).toBe("classified");
    expect((await row(db, "t")).status).not.toBe("skipped");
  });

  it("Gmail で未読に戻したメールは未読にする", async () => {
    const { db, user, mail } = await setup([{ id: "u", status: "done", unread: false }]);
    mail.change("u", ["UNREAD"], []);
    await sync(db, mail, user);
    expect((await row(db, "u")).unread).toBe(true);
  });

  it("Gmail で完全に削除したメールは一覧から外す", async () => {
    const { db, user, mail } = await setup([{ id: "d", status: "new", needsReply: true }]);
    mail.deleteForever("d");
    await sync(db, mail, user);
    expect(await row(db, "d")).toMatchObject({ status: "skipped", needsReply: false });
  });

  it("1ページに同じメールの操作が複数あれば最後の状態にする", async () => {
    const { db, user, mail } = await setup([
      { id: "back", status: "done" },
      { id: "away", status: "done" },
      { id: "untrash", status: "done" },
      { id: "reread", status: "done", unread: false },
    ]);
    mail.change("back", [], ["INBOX"]);
    mail.change("back", ["INBOX"], []);
    mail.change("away", ["INBOX"], []);
    mail.change("away", [], ["INBOX"]);
    mail.change("untrash", ["TRASH"], []);
    mail.change("untrash", [], ["TRASH"]);
    mail.change("reread", ["UNREAD"], []);
    mail.change("reread", [], ["UNREAD"]);
    await sync(db, mail, user);
    expect((await row(db, "back")).status).toBe("done");
    expect((await row(db, "away")).status).toBe("archived");
    expect((await row(db, "untrash")).status).toBe("done");
    expect((await row(db, "reread")).unread).toBe(false);
  });
});

describe("履歴のまとめ方", () => {
  it("後の操作が勝ち、削除は他の変更より優先し、下書きは届いたメールに含めない", () => {
    const m = (id: string) => ({ message: { id } });
    const h = summarizeHistory(
      [
        { messagesAdded: [m("new"), { message: { id: "draft", labelIds: ["DRAFT"] } }, m("gone")] },
        { labelsRemoved: [{ ...m("x"), labelIds: ["INBOX", "UNREAD"] }] },
        { labelsAdded: [{ ...m("x"), labelIds: ["INBOX"] }, { ...m("gone"), labelIds: ["TRASH"] }] },
        { labelsAdded: [{ ...m("sp"), labelIds: ["SPAM"] }], labelsRemoved: [{ ...m("sp"), labelIds: ["CATEGORY_PROMOTIONS"] }] },
        { labelsRemoved: [{ ...m("promo"), labelIds: ["CATEGORY_PROMOTIONS", "Label_9"] }] },
        { messagesDeleted: [m("gone")] },
      ],
      "300",
    );
    expect(h).toEqual({
      messageIds: ["new"],
      readIds: ["x"],
      unreadIds: [],
      restoredIds: ["promo"],
      archivedIds: [],
      inboxIds: ["x"],
      trashedIds: ["sp"],
      deletedIds: ["gone"],
      historyId: "300",
    });
  });
});
