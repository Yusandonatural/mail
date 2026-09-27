import { describe, expect, it } from "vitest";
import { mergeClassification } from "@/lib/classify/merge";
import type { Stage1Result } from "@/lib/classify/stage1";
import type { ContentClassification } from "@/lib/classify/types";

const content = (over: Partial<ContentClassification> = {}): ContentClassification => ({
  category: "wholesale",
  needs_reply: true,
  urgency: "normal",
  language: "ja",
  dates: [],
  amount: null,
  due_date: null,
  summary: "",
  accepts_proposed_time: false,
  confidence: 0.9,
  ...over,
});

const stage1 = (over: Partial<Stage1Result>): Stage1Result => ({
  folder: null,
  source: "none",
  contentDecides: true,
  secondaryFolders: [],
  matchedAddress: null,
  ...over,
});

describe("判定の合成ルール（仕様書 4章）", () => {
  it("宛先と内容が一致すれば確定", () => {
    const r = mergeClassification(stage1({ folder: "wholesale", source: "address", contentDecides: false }), content());
    expect(r).toMatchObject({ folder: "wholesale", needsReview: false, source: "address" });
  });

  it("不一致なら内容を優先し、要確認を付け、宛先のフォルダは副ラベルに残す", () => {
    const r = mergeClassification(
      stage1({ folder: "wholesale", source: "address", contentDecides: false }),
      content({ category: "keiri" }),
    );
    expect(r).toMatchObject({ folder: "keiri", needsReview: true, source: "content" });
    expect(r.secondaryFolders).toContain("wholesale");
  });

  it("送信者ルールは内容より優先し、要確認にしない", () => {
    const r = mergeClassification(stage1({ folder: "keiri", source: "sender_rule", contentDecides: false }), content());
    expect(r).toMatchObject({ folder: "keiri", needsReview: false, source: "sender_rule" });
  });

  it("総合窓口（info@）宛ては内容でフォルダを決め、不一致扱いにしない", () => {
    const r = mergeClassification(stage1({ folder: "general", source: "address", contentDecides: true }), content({ category: "tour" }));
    expect(r).toMatchObject({ folder: "tour", needsReview: false });
  });

  it("個人アドレス宛ては個人フォルダに置いたまま、業務フォルダを副ラベルで付ける", () => {
    const r = mergeClassification(stage1({ folder: "personal", source: "address", contentDecides: true }), content({ category: "press" }));
    expect(r.folder).toBe("personal");
    expect(r.secondaryFolders).toEqual(["press"]);
    expect(r.category).toBe("press");
  });

  it("信頼度 0.7 未満は要確認", () => {
    const r = mergeClassification(stage1({ folder: "wholesale", source: "address", contentDecides: false }), content({ confidence: 0.5 }));
    expect(r.needsReview).toBe(true);
  });

  it("内容分類に失敗したら宛先のフォルダに置いて要確認", () => {
    const r = mergeClassification(stage1({ folder: "tour", source: "address", contentDecides: false }), null);
    expect(r).toMatchObject({ folder: "tour", needsReview: true });
  });
});
