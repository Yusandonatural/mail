import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { freeeUploads, messages, settings } from "@/lib/db/schema";
import {
  clearFreeeTokenCache,
  freeeAccessToken,
  FreeeHttpApi,
  FreeeNotConnectedError,
  saveFreeeConnection,
  type FreeeApi,
  type FreeeReceiptInput,
} from "@/lib/freee";
import { receiptDescription, sendAttachmentToFreee } from "@/lib/freee-service";
import { decryptSecret } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.FREEE_CLIENT_ID = "cid";
  process.env.FREEE_CLIENT_SECRET = "secret";
});

class FakeFreee implements FreeeApi {
  uploads: FreeeReceiptInput[] = [];
  async companies() {
    return [{ id: 1, name: "株式会社悠三堂" }];
  }
  async uploadReceipt(input: FreeeReceiptInput) {
    this.uploads.push(input);
    return { id: String(1000 + this.uploads.length) };
  }
}

async function setup() {
  const db = await testDb();
  const user = await makeUser(db);
  const mail = new FakeMail();
  mail.add(
    gmailMessage({
      id: "m1",
      from: "請求担当 <billing@vendor.example>",
      to: "keiri@yusando.com",
      messageId: "<inv-1@vendor.example>",
      date: new Date("2026-09-27T01:00:00Z"),
      attachments: [
        { filename: "請求書_9月.pdf", mimeType: "application/pdf", attachmentId: "a1" },
        { filename: "明細.xlsx", mimeType: "application/vnd.ms-excel", attachmentId: "a2" },
      ],
    }),
  );
  const [row] = await db
    .insert(messages)
    .values({
      userId: user.id,
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      rfcMessageId: "<inv-1@vendor.example>",
      fromEmail: "billing@vendor.example",
      fromName: "請求担当",
      subject: "9月分請求書",
      folder: "keiri",
      category: "keiri",
      source: "address",
      amount: 55000,
      currency: "JPY",
      dueDate: "2026-10-31",
      receivedAt: new Date("2026-09-27T01:00:00Z"),
    })
    .returning();
  return { db, user, mail, row };
}

describe("freee のファイルボックスに送る", () => {
  it("連携していなければ送らない", async () => {
    const { db, user, mail, row } = await setup();
    await expect(sendAttachmentToFreee({ db, mail, freee: new FakeFreee() }, user, row, "1")).rejects.toBeInstanceOf(
      FreeeNotConnectedError,
    );
  });

  it("PDF を送り、説明と日付を付け、二度は送らない", async () => {
    const { db, user, mail, row } = await setup();
    await saveFreeeConnection(db, "refresh-1", [{ id: 42, name: "株式会社悠三堂" }], "isozaki@yusando.com");
    const freee = new FakeFreee();
    const r1 = await sendAttachmentToFreee({ db, mail, freee }, user, row, "1");
    expect(r1).toEqual({ kind: "uploaded", receiptId: "1001" });
    expect(freee.uploads[0]).toMatchObject({
      companyId: 42,
      filename: "請求書_9月.pdf",
      mimeType: "application/pdf",
      description: "請求担当 / 9月分請求書 / ¥55,000 / 期限 2026-10-31",
      issueDate: "2026-09-27",
    });
    expect(mail.labelsAddedTo("m1")).toContain("状態/freee送信済");

    const r2 = await sendAttachmentToFreee({ db, mail, freee }, user, row, "1");
    expect(r2).toEqual({ kind: "already", receiptId: "1001" });
    expect(freee.uploads).toHaveLength(1);
    expect(await db.select().from(freeeUploads)).toHaveLength(1);
  });

  it("PDF・画像以外は送らない", async () => {
    const { db, user, mail, row } = await setup();
    await saveFreeeConnection(db, "refresh-1", [{ id: 42, name: "悠三堂" }], "a");
    await expect(sendAttachmentToFreee({ db, mail, freee: new FakeFreee() }, user, row, "2")).rejects.toThrow(
      "PDF と画像",
    );
  });

  it("外貨の金額も説明に入れる", () => {
    expect(
      receiptDescription({ fromName: null, fromEmail: "a@b.c", subject: "Invoice", amount: 120, currency: "USD", dueDate: null }),
    ).toBe("a@b.c / Invoice / 120 USD");
  });
});

function tokenFetch(responses: Array<{ ok: boolean; body?: unknown }>) {
  const calls: URLSearchParams[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(new URLSearchParams(String(init.body)));
    const r = responses.shift()!;
    return { ok: r.ok, status: r.ok ? 200 : 401, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("freee のトークン", () => {
  it("リフレッシュトークンは使うたびに新しいものを保存し、有効な間は使い回す", async () => {
    clearFreeeTokenCache();
    const db = await testDb();
    await saveFreeeConnection(db, "refresh-1", [{ id: 42, name: "悠三堂" }], "a");
    const { impl, calls } = tokenFetch([{ ok: true, body: { access_token: "acc-1", refresh_token: "refresh-2", expires_in: 21600 } }]);
    expect(await freeeAccessToken(db, impl)).toBe("acc-1");
    expect(calls[0].get("refresh_token")).toBe("refresh-1");
    expect(calls[0].get("grant_type")).toBe("refresh_token");
    const s = await getSetting(db, "freee");
    expect(decryptSecret(s.refreshTokenEnc!)).toBe("refresh-2");
    expect(s.companyId).toBe(42);
    // キャッシュが効いて、もう一度は取りに行かない
    expect(await freeeAccessToken(db, impl)).toBe("acc-1");
    expect(calls).toHaveLength(1);
  });

  it("別のサーバーが先に更新していたら、新しいトークンでやり直す", async () => {
    clearFreeeTokenCache();
    const db = await testDb();
    await saveFreeeConnection(db, "old", [{ id: 1, name: "x" }], "a");
    const before = (await getSetting(db, "freee")).refreshTokenEnc;
    let rotated = false;
    const calls: string[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      const rt = new URLSearchParams(String(init.body)).get("refresh_token")!;
      calls.push(rt);
      if (rt === "old") {
        if (!rotated) {
          // 失敗する間に、別のサーバーがトークンを回したことにする
          rotated = true;
          await saveFreeeConnection(db, "new", [{ id: 1, name: "x" }], "a");
          clearFreeeTokenCache();
        }
        return { ok: false, status: 401, json: async () => ({}) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ access_token: "acc", refresh_token: "newer", expires_in: 100 }) } as Response;
    }) as unknown as typeof fetch;
    expect(await freeeAccessToken(db, impl)).toBe("acc");
    expect(calls).toEqual(["old", "new"]);
    expect((await getSetting(db, "freee")).refreshTokenEnc).not.toBe(before);
    expect(await db.select().from(settings)).toBeDefined();
  });

  it("ファイルボックスへの送信は multipart で事業所・説明・日付・ファイルを送る", async () => {
    let captured: { url: string; body: FormData; auth: string } | null = null;
    const impl = (async (url: string, init: RequestInit) => {
      captured = { url, body: init.body as FormData, auth: (init.headers as Record<string, string>).Authorization };
      return { ok: true, status: 201, json: async () => ({ receipt: { id: 555 } }) } as Response;
    }) as unknown as typeof fetch;
    const api = new FreeeHttpApi(async () => "tok", impl);
    const r = await api.uploadReceipt({
      companyId: 42,
      filename: "請求書.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4"),
      description: "説明",
      issueDate: "2026-09-27",
    });
    expect(r).toEqual({ id: "555" });
    expect(captured!.url).toBe("https://api.freee.co.jp/api/1/receipts");
    expect(captured!.auth).toBe("Bearer tok");
    expect(captured!.body.get("company_id")).toBe("42");
    expect(captured!.body.get("issue_date")).toBe("2026-09-27");
    const file = captured!.body.get("receipt") as File;
    expect(file.name).toBe("請求書.pdf");
    expect(file.type).toBe("application/pdf");
  });
});
