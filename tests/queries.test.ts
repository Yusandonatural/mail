import { describe, expect, it } from "vitest";
import { dateCandidates, messages } from "@/lib/db/schema";
import { folderCounts, listMessages } from "@/lib/queries";
import { makeUser, testDb } from "./helpers/db";

async function seed() {
  const db = await testDb();
  const admin = await makeUser(db);
  const base = {
    userId: admin.id,
    fromEmail: "a@b.example",
    subject: "s",
    source: "address",
    receivedAt: new Date("2026-09-27T00:00:00Z"),
  };
  await db.insert(messages).values([
    { ...base, gmailMessageId: "m1", gmailThreadId: "t1", folder: "wholesale", category: "wholesale", needsReply: true, status: "new" },
    { ...base, gmailMessageId: "m2", gmailThreadId: "t2", folder: "keiri", category: "keiri", status: "done" },
    {
      ...base,
      gmailMessageId: "m3",
      gmailThreadId: "t3",
      folder: "personal",
      secondaryFolders: ["tour"],
      category: "tour",
      needsReply: true,
      status: "draft_ready",
      needsReview: true,
    },
  ]);
  await db.insert(dateCandidates).values({
    userId: admin.id,
    gmailMessageId: "m3",
    gmailThreadId: "t3",
    kind: "visit",
    title: "見学",
    start: "2026-10-03T10:00:00+09:00",
  });
  return { db, admin };
}

describe("一覧の取得", () => {
  it("日程ありは、候補があるメールだけに付く", async () => {
    const { db, admin } = await seed();
    const rows = await listMessages(db, admin, { folder: null, filter: "all", page: 0 });
    const byId = Object.fromEntries(rows.map((r) => [r.gmailMessageId, r.hasDates]));
    expect(byId).toEqual({ m1: false, m2: false, m3: true });
    const dated = await listMessages(db, admin, { folder: null, filter: "dates", page: 0 });
    expect(dated.map((r) => r.gmailMessageId)).toEqual(["m3"]);
  });

  it("副ラベルのフォルダにも表示し、絞り込みが効く", async () => {
    const { db, admin } = await seed();
    const tour = await listMessages(db, admin, { folder: "tour", filter: "all", page: 0 });
    expect(tour.map((r) => r.gmailMessageId)).toEqual(["m3"]);
    const reply = await listMessages(db, admin, { folder: null, filter: "reply", page: 0 });
    expect(reply.map((r) => r.gmailMessageId).sort()).toEqual(["m1", "m3"]);
    const review = await listMessages(db, admin, { folder: null, filter: "review", page: 0 });
    expect(review.map((r) => r.gmailMessageId)).toEqual(["m3"]);
  });

  it("担当者には見られるフォルダのメールだけを出す", async () => {
    const { db } = await seed();
    const staff = await makeUser(db, { email: "staff@yusando.com", role: "staff", visibleFolders: ["wholesale"] });
    // 担当者の受信箱にも同じメールがあるとする
    await db.insert(messages).values([
      { userId: staff.id, gmailMessageId: "s1", gmailThreadId: "t1", fromEmail: "a@b.example", folder: "wholesale", source: "address", receivedAt: new Date() },
      { userId: staff.id, gmailMessageId: "s2", gmailThreadId: "t2", fromEmail: "a@b.example", folder: "keiri", source: "address", receivedAt: new Date() },
    ]);
    const rows = await listMessages(db, staff, { folder: null, filter: "all", page: 0 });
    expect(rows.map((r) => r.gmailMessageId)).toEqual(["s1"]);
  });

  it("フォルダごとの件数を副ラベルも含めて数える", async () => {
    const { db, admin } = await seed();
    const counts = await folderCounts(db, admin);
    expect(counts.get("wholesale")).toMatchObject({ reply: 1 });
    expect(counts.get("tour")).toMatchObject({ reply: 1, review: 1 });
    expect(counts.get("personal")).toMatchObject({ reply: 1 });
    expect(counts.get("keiri")).toMatchObject({ reply: 0 });
  });
});
