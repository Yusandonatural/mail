import { describe, expect, it } from "vitest";
import { jobs, pushSubscriptions, type PushSubscriptionRow } from "@/lib/db/schema";
import { notifyUser, type Notifier, type PushPayload } from "@/lib/notify";
import { processMessage } from "@/lib/pipeline";
import { putSetting } from "@/lib/settings";
import type { Classifier, ContentClassification } from "@/lib/classify/types";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

const classifier = (over: Partial<ContentClassification>): Classifier => ({
  classify: async () => ({
    category: "wholesale",
    needs_reply: true,
    urgency: "normal",
    language: "ja",
    dates: [],
    amount: null,
    due_date: null,
    summary: "至急の問合せ",
    accepts_proposed_time: false,
    confidence: 0.9,
    ...over,
  }),
});

async function run(over: Partial<ContentClassification>, mode?: "urgent" | "replies" | "off") {
  const db = await testDb();
  const user = await makeUser(db);
  if (mode) await putSetting(db, "notify", { mode });
  const mail = new FakeMail();
  mail.add(gmailMessage({ id: "m1", from: "Ben <ben@x.example>", to: "wholesale@yusando.com" }));
  await processMessage({ db, mail, classifier: classifier(over) }, user, "m1");
  return (await db.select().from(jobs)).filter((j) => j.kind === "notify");
}

describe("通知", () => {
  it("既定では至急の要返信だけ通知する", async () => {
    const urgent = await run({ urgency: "high" });
    expect(urgent).toHaveLength(1);
    expect(urgent[0].payload).toMatchObject({ title: "【至急】Ben", body: "至急の問合せ" });
    expect(await run({ urgency: "normal" })).toHaveLength(0);
    expect(await run({ urgency: "high", needs_reply: false })).toHaveLength(0);
  });

  it("設定で要返信すべて・通知しないを選べる", async () => {
    expect(await run({ urgency: "normal" }, "replies")).toHaveLength(1);
    expect(await run({ urgency: "high" }, "off")).toHaveLength(0);
  });

  it("無効になった端末は宛先から消す", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(pushSubscriptions).values([
      { userId: user.id, endpoint: "https://push.example/ok", p256dh: "k", auth: "a" },
      { userId: user.id, endpoint: "https://push.example/gone", p256dh: "k", auth: "a" },
    ]);
    const sent: string[] = [];
    const notifier: Notifier = {
      send: async (sub: PushSubscriptionRow, _p: PushPayload) => {
        sent.push(sub.endpoint);
        return sub.endpoint.endsWith("gone") ? "gone" : "ok";
      },
    };
    const n = await notifyUser(db, notifier, user.id, { title: "t", body: "b", url: "/m/1", tag: "x" });
    expect(n).toBe(1);
    expect(sent).toHaveLength(2);
    const left = await db.select().from(pushSubscriptions);
    expect(left.map((s) => s.endpoint)).toEqual(["https://push.example/ok"]);
  });
});
