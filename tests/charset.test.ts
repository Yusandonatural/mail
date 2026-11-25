import { describe, expect, it } from "vitest";
import {
  decodeBytes,
  decodeHeaderText,
  decodeMimeWords,
  decodeText,
  normalizeCharset,
  parseMessage,
  repairLatin1Mojibake,
} from "@/lib/mail/parse";

const TEXT = "お世話になっております。お茶の件でご連絡しました。①番の件、㈱様へお伝えします。";
const utf8 = (text: string) => Buffer.from(text, "utf8");
const hex = (h: string) => Buffer.from(h.replace(/\s/g, ""), "hex");

// Node の TextEncoder は日本語の旧文字コードに符号化できないので、既知のバイト列を使う
const HELLO = "こんにちは、世界";
const HELLO_SJIS = hex("82b182f182c982bf82cd8141 90a28a45");
const HELLO_EUC = hex("a4b3a4f3a4cba4c1a4cfa1a2 c0a4b3a6");
const HELLO_JIS = Buffer.concat([
  Buffer.from([0x1b, 0x24, 0x42]),
  Buffer.from('$3$s$K$A$O!"@$3&', "latin1"),
  Buffer.from([0x1b, 0x28, 0x42]),
]);

describe("文字コードの別名", () => {
  it.each([
    ["CP932", "shift_jis"],
    ["MS932", "shift_jis"],
    ["Windows-31J", "shift_jis"],
    ["SJIS", "shift_jis"],
    ["Shift-JIS", "shift_jis"],
    ["ISO-2022-JP-2", "iso-2022-jp"],
    ["csISO2022JP", "iso-2022-jp"],
    ["CP50220", "iso-2022-jp"],
    ["x-euc-jp", "euc-jp"],
    ["eucJP-ms", "euc-jp"],
    ['"UTF8"', "utf-8"],
    ["US-ASCII", "us-ascii"],
  ])("%s → %s", (raw, want) => expect(normalizeCharset(raw)).toBe(want));
});

describe("本文の文字コード", () => {
  it("宣言どおりに読む", () => {
    expect(decodeBytes(HELLO_SJIS, "Shift_JIS")).toBe(HELLO);
    expect(decodeBytes(HELLO_SJIS, "MS932")).toBe(HELLO);
    expect(decodeBytes(HELLO_EUC, "EUC-JP")).toBe(HELLO);
    expect(decodeBytes(HELLO_JIS, "ISO-2022-JP")).toBe(HELLO);
    expect(decodeBytes(HELLO_JIS, "iso-2022-jp-2")).toBe(HELLO);
  });

  it("宣言が無いときは中身から推定する", () => {
    expect(decodeBytes(HELLO_SJIS, null)).toBe(HELLO);
    expect(decodeBytes(HELLO_EUC, null)).toBe(HELLO);
    expect(decodeBytes(HELLO_JIS, null)).toBe(HELLO);
    expect(decodeBytes(utf8(TEXT), null)).toBe(TEXT);
  });

  it("us-ascii と書かれた ISO-2022-JP・UTF-8 を読む", () => {
    expect(decodeBytes(HELLO_JIS, "us-ascii")).toBe(HELLO);
    expect(decodeBytes(utf8(TEXT), "us-ascii")).toBe(TEXT);
  });

  it("宣言違い（UTF-8 と書かれた Shift_JIS、Shift_JIS や Latin-1 と書かれた UTF-8）でも読む", () => {
    expect(decodeBytes(HELLO_SJIS, "utf-8")).toBe(HELLO);
    expect(decodeBytes(utf8(TEXT), "shift_jis")).toBe(TEXT);
    expect(decodeBytes(utf8(TEXT), "iso-8859-1")).toBe(TEXT);
  });

  it("本物の Latin-1 や英文はそのまま", () => {
    expect(decodeBytes(Buffer.from("Réservation confirmée", "latin1"), "iso-8859-1")).toBe("Réservation confirmée");
    expect(decodeBytes(Buffer.from("plain text", "latin1"), null)).toBe("plain text");
  });

  it("base64url の本文（従来どおり）", () => {
    expect(decodeText(HELLO_SJIS.toString("base64url"), "x-sjis")).toBe(HELLO);
  });
});

describe("ヘッダー", () => {
  it("残った RFC 2047 を戻す（分割された ISO-2022-JP をつなげて読む）", () => {
    const a = HELLO_JIS.subarray(0, 9).toString("base64");
    const b = HELLO_JIS.subarray(9).toString("base64");
    expect(decodeMimeWords(`=?ISO-2022-JP?B?${a}?=\r\n =?ISO-2022-JP?B?${b}?=`)).toBe(HELLO);
    expect(decodeMimeWords(`Re: =?shift_jis?B?${HELLO_SJIS.toString("base64")}?= です`)).toBe(`Re: ${HELLO} です`);
    expect(decodeMimeWords("=?UTF-8?Q?=E3=81=8A=E8=8C=B6_tea?=")).toBe("お茶 tea");
    expect(decodeMimeWords("普通の件名")).toBe("普通の件名");
  });

  it("Latin-1 として読まれた 8 ビットのヘッダーを直す", () => {
    expect(repairLatin1Mojibake(utf8(TEXT).toString("latin1"))).toBe(TEXT);
    expect(repairLatin1Mojibake(HELLO_SJIS.toString("latin1"))).toBe(HELLO);
    expect(repairLatin1Mojibake("Réservation confirmée")).toBe("Réservation confirmée");
    expect(repairLatin1Mojibake("café ☕")).toBe("café ☕");
  });

  it("parseMessage で件名・差出人名・本文（meta charset）を直す", () => {
    const html = Buffer.concat([
      Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head><body>', "latin1"),
      HELLO_SJIS,
      Buffer.from("</body></html>", "latin1"),
    ]);
    const m = parseMessage({
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "Subject", value: `=?ISO-2022-JP?B?${HELLO_JIS.toString("base64")}?=` },
          { name: "From", value: `=?shift_jis?B?${HELLO_SJIS.toString("base64")}?= <sender@example.jp>` },
          { name: "Content-Type", value: "text/html" },
        ],
        body: { data: html.toString("base64url") },
      },
    });
    expect(m.subject).toBe(HELLO);
    expect(m.from).toEqual({ name: HELLO, email: "sender@example.jp" });
    expect(m.text).toBe(HELLO);
    expect(decodeHeaderText("Hello")).toBe("Hello");
  });
});

describe("保存済みの文字化けを直す", () => {
  it("件名・差出人名・連絡先名を直し、正しいものは触らない", async () => {
    const { testDb, makeUser } = await import("./helpers/db");
    const { messages, contacts } = await import("@/lib/db/schema");
    const { repairStoredHeaders } = await import("@/lib/db/repair");
    const db = await testDb();
    const user = await makeUser(db);
    const base = {
      userId: user.id,
      gmailThreadId: "t",
      fromEmail: "a@example.jp",
      folder: "inbox",
      category: "other",
      source: "address",
      summary: "",
      receivedAt: new Date(),
    };
    await db.insert(messages).values([
      { ...base, gmailMessageId: "bad", subject: `=?ISO-2022-JP?B?${HELLO_JIS.toString("base64")}?=`, fromName: utf8(TEXT).toString("latin1") },
      { ...base, gmailMessageId: "ok", subject: "Réservation confirmée", fromName: "山田" },
    ]);
    await db.insert(contacts).values({ email: "a@example.jp", name: HELLO_SJIS.toString("latin1") });
    expect(await repairStoredHeaders(db)).toBe(2);
    const rows = await db.select().from(messages);
    expect(rows.find((r) => r.gmailMessageId === "bad")).toMatchObject({ subject: HELLO, fromName: TEXT });
    expect(rows.find((r) => r.gmailMessageId === "ok")).toMatchObject({ subject: "Réservation confirmée", fromName: "山田" });
    expect((await db.select().from(contacts))[0].name).toBe(HELLO);
    expect(await repairStoredHeaders(db)).toBe(0);
  });
});
