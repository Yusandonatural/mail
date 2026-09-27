import { describe, expect, it } from "vitest";
import { buildMime, encodeHeaderWord, replySubject } from "@/lib/mail/mime";
import { htmlToText, listIdToAddress, parseAddressList, parseMessage, stripQuoted } from "@/lib/mail/parse";
import { findPlaceholders, hasPlaceholders } from "@/lib/placeholders";
import { gmailMessage } from "./helpers/fake-mail";

describe("アドレスの解析", () => {
  it("引用符内のカンマや日本語の名前を扱える", () => {
    expect(parseAddressList('"Doe, Jane" <Jane@Example.com>, 山田 太郎 <yamada@example.jp>, x@y.z')).toEqual([
      { name: "Doe, Jane", email: "jane@example.com" },
      { name: "山田 太郎", email: "yamada@example.jp" },
      { name: null, email: "x@y.z" },
    ]);
  });
  it("List-Id をグループのアドレスに直す", () => {
    expect(listIdToAddress("keiri <keiri.yusando.com>")).toBe("keiri@yusando.com");
    expect(listIdToAddress(null)).toBeNull();
  });
});

describe("本文の取り出し", () => {
  it("text/plain が無ければ HTML からテキストにする", () => {
    const m = parseMessage(
      gmailMessage({ id: "1", from: "a@b.c", html: "<p>こんにちは<br>悠三堂様</p><script>x()</script><p>A &amp; B</p>" }),
    );
    expect(m.text).toBe("こんにちは\n悠三堂様\nA & B");
  });
  it("添付ファイルを一覧にする", () => {
    const m = parseMessage(
      gmailMessage({
        id: "1",
        from: "a@b.c",
        attachments: [{ filename: "請求書.pdf", mimeType: "application/pdf", attachmentId: "att1" }],
      }),
    );
    expect(m.attachments).toEqual([{ partId: "1", filename: "請求書.pdf", mimeType: "application/pdf", attachmentId: "att1", size: 10 }]);
  });
  it("引用部分を落とす", () => {
    const text = "了解しました。\n\n2026年9月20日(日) 10:00 悠三堂 <info@yusando.com>:\n> 前回の本文";
    expect(stripQuoted(text)).toBe("了解しました。");
    expect(stripQuoted("Sounds good.\nOn Sun, Sep 20, 2026 Ryotaro wrote:\n> old")).toBe("Sounds good.");
  });
  it("HTML の数値文字参照を戻す", () => {
    expect(htmlToText("&#12354;&#x3044;")).toBe("あい");
  });
});

describe("MIME の生成", () => {
  it("日本語の件名を RFC 2047 で符号化する", () => {
    const enc = encodeHeaderWord("Re: 抹茶5kgのお問い合わせについて");
    expect(enc).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = enc
      .split("\r\n ")
      .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("Re: 抹茶5kgのお問い合わせについて");
  });
  it("返信の件名に Re: を重ねない", () => {
    expect(replySubject("お問い合わせ")).toBe("Re: お問い合わせ");
    expect(replySubject("RE: お問い合わせ")).toBe("RE: お問い合わせ");
  });
  it("スレッドにつながるヘッダと本文を入れる", () => {
    const raw = buildMime({
      from: { name: "悠三堂", email: "wholesale@yusando.com" },
      to: [{ name: null, email: "buyer@shop.example" }],
      subject: "Re: Matcha",
      text: "こんにちは\n悠三堂です",
      inReplyTo: "<abc@x>",
      references: "<root@x>",
    });
    expect(raw).toContain("In-Reply-To: <abc@x>");
    expect(raw).toContain("References: <root@x> <abc@x>");
    expect(raw).toContain("To: buyer@shop.example");
    const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("こんにちは\r\n悠三堂です");
  });
  it("添付付きは multipart/mixed にする", () => {
    const raw = buildMime({
      to: [{ name: null, email: "a@b.c" }],
      subject: "Fwd: 請求書",
      text: "転送します",
      attachments: [{ filename: "請求書.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF") }],
    });
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("Content-Disposition: attachment");
  });
});

describe("【要確認】の検出", () => {
  it("日本語と英語の空欄を拾う", () => {
    const text = "卸価格は【要確認：kg単価】です。MOQ is [CONFIRM: MOQ].";
    expect(findPlaceholders(text).map((p) => p.label)).toEqual(["kg単価", "MOQ"]);
    expect(hasPlaceholders("全部埋まりました")).toBe(false);
  });
});
