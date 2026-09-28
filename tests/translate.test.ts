import { beforeEach, describe, expect, it } from "vitest";
import { clearTranslationCache, isMostlyJapanese, translateIncoming, translateReply, type Translator } from "@/lib/translate";
import { findPlaceholders } from "@/lib/placeholders";
import type { Language } from "@/lib/domain";

class FakeTranslator implements Translator {
  incoming = 0;
  lastOutgoing: { body: string; target: Language } | null = null;
  async toJapanese(input: { subject: string; body: string }) {
    this.incoming++;
    return { subject: `訳:${input.subject}`, body: `訳:${input.body}` };
  }
  async fromJapanese(input: { body: string; target: Language }) {
    this.lastOutgoing = input;
    return "Hi Ben,\nThe price is 【要確認：price per kg】.";
  }
}

beforeEach(() => clearTranslationCache());

describe("日本語かどうか", () => {
  it("かなのある文は日本語、英語・中国語・フランス語は翻訳の対象", () => {
    expect(isMostlyJapanese("いつもお世話になっております。見積りをお送りします。")).toBe(true);
    expect(isMostlyJapanese("Could you quote 5kg of matcha?")).toBe(false);
    expect(isMostlyJapanese("您好，我们想订购五公斤抹茶，请问价格是多少？")).toBe(false);
    expect(isMostlyJapanese("Bonjour, nous aimerions commander du thé.")).toBe(false);
    // 英文の中に日本語の商品名が少し混ざっていても翻訳する
    expect(isMostlyJapanese("We loved the 満月萌茶 you sent. Can we order 20 packs for our shop in Paris next month?")).toBe(false);
  });
});

describe("受信メールの翻訳", () => {
  it("同じメールは2回目から翻訳し直さない", async () => {
    const t = new FakeTranslator();
    const a = await translateIncoming(t, { subject: "Matcha", body: "Hello" });
    const b = await translateIncoming(t, { subject: "Matcha", body: "Hello" });
    expect(a).toEqual({ subject: "訳:Matcha", body: "訳:Hello" });
    expect(b).toEqual(a);
    expect(t.incoming).toBe(1);
  });
});

describe("返信の翻訳", () => {
  const signatures = { ja: "─────\n株式会社悠三堂　礒﨑遼太郎\n─────", en: "─────\nRyotaro Isozaki\nYusando Inc.\n─────" };

  it("日本語の署名を外して訳し、英語の署名に差し替える", async () => {
    const t = new FakeTranslator();
    const out = await translateReply(t, {
      text: `ベン様\n\n価格は【要確認：kg単価】です。\n\n${signatures.ja}`,
      target: "en",
      signatures,
    });
    expect(t.lastOutgoing?.body).not.toContain("礒﨑");
    expect(t.lastOutgoing?.target).toBe("en");
    expect(out).toContain("Ryotaro Isozaki");
    expect(out).not.toContain("株式会社悠三堂");
    // 【要確認】は残るので、埋めるまで送信できない
    expect(findPlaceholders(out)).toHaveLength(1);
  });

  it("署名が無ければ署名を足さない", async () => {
    const out = await translateReply(new FakeTranslator(), { text: "価格は【要確認：kg単価】です。", target: "fr", signatures });
    expect(out).not.toContain("Ryotaro Isozaki");
  });
});
