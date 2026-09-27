import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, messages, users } from "@/lib/db/schema";
import { backfill, ensureWatch, syncUser } from "@/lib/sync";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

describe("Gmail との同期", () => {
  it("初回は履歴 ID を覚えるだけ、次からは届いたメールをキューに積む", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "a", from: "x@y.z" }));
    expect(await syncUser(db, mail, user)).toBe(0);
    const [u1] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u1.historyId).toBe("100");
    expect(await syncUser(db, mail, u1)).toBe(1);
    // 同じメールは二度積まない
    const [u2] = await db.select().from(users).where(eq(users.id, user.id));
    expect(await syncUser(db, mail, u2)).toBe(0);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("Gmail 側で既読になったメールを既読にする", async () => {
    const db = await testDb();
    const user = await makeUser(db, { historyId: "90" });
    await db.insert(messages).values({
      userId: user.id,
      gmailMessageId: "r1",
      gmailThreadId: "t",
      fromEmail: "x@y.z",
      folder: "general",
      source: "address",
      receivedAt: new Date(),
      unread: true,
    });
    const mail = new FakeMail();
    mail.readIds = ["r1"];
    await syncUser(db, mail, user);
    const [row] = await db.select().from(messages);
    expect(row.unread).toBe(false);
  });

  it("watch は20時間ごとに更新する", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    const now = new Date("2026-09-27T00:00:00Z");
    expect(await ensureWatch(db, mail, user, "projects/p/topics/t", now)).toBe(true);
    const [u] = await db.select().from(users);
    expect(await ensureWatch(db, mail, u, "projects/p/topics/t", new Date(now.getTime() + 3600e3))).toBe(false);
    expect(await ensureWatch(db, mail, u, "projects/p/topics/t", new Date(now.getTime() + 21 * 3600e3))).toBe(true);
    expect(await ensureWatch(db, mail, u, "", now)).toBe(false);
  });

  it("過去メールの取り込みは下書きを作らない印を付けて積む", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "old", from: "x@y.z" }));
    expect(await backfill(db, mail, user, 30)).toBe(1);
    const [job] = await db.select().from(jobs);
    expect(job.payload).toMatchObject({ messageId: "old", backfill: true });
  });
});
