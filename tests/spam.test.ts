import { describe, expect, it } from "vitest";
import { processMessage } from "@/lib/pipeline";
import { messages, rules } from "@/lib/db/schema";
import { matchBlockRule, matchSenderRule } from "@/lib/classify/stage1";
import { BLOCK_RULE, ruleTargetName } from "@/lib/domain";
import type { Classifier } from "@/lib/classify/types";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

const neverCalled: Classifier = {
  classify: async () => {
    throw new Error("迷惑メールの送信者は分類しない");
  },
};

describe("迷惑メールの送信者ルール", () => {
  it("ブロックのルールはフォルダ振り分けには使わず、別に判定する", () => {
    const r = [
      { kind: "sender" as const, pattern: "spam@bad.example", folder: BLOCK_RULE },
      { kind: "domain" as const, pattern: "junk.example", folder: BLOCK_RULE },
    ];
    expect(matchSenderRule("spam@bad.example", r)).toBeNull();
    expect(matchBlockRule("spam@bad.example", r)?.pattern).toBe("spam@bad.example");
    expect(matchBlockRule("x@mail.junk.example", r)?.pattern).toBe("junk.example");
    expect(matchBlockRule("ok@good.example", r)).toBeNull();
    expect(ruleTargetName(BLOCK_RULE)).toBe("迷惑メール（自動）");
    expect(ruleTargetName("tour")).not.toBe("tour");
  });

  it("ブロックした送信者のメールは、分類せずに迷惑メールへ移し、一覧に出さない", async () => {
    const db = await testDb();
    const user = await makeUser(db);
    await db.insert(rules).values({ kind: "sender", pattern: "spam@bad.example", folder: BLOCK_RULE });
    const mail = new FakeMail();
    mail.add(gmailMessage({ id: "s1", from: "Spam <spam@bad.example>", to: "info@yusando.com", text: "WIN" }));
    const r = await processMessage({ db, mail, classifier: neverCalled }, user, "s1");
    expect(r).toEqual({ kind: "skipped", reason: "blocked" });
    expect(mail.modifications).toContainEqual({ id: "s1", add: ["SPAM"], remove: ["INBOX", "UNREAD"] });
    expect(await db.select().from(messages)).toHaveLength(0);
  });
});
