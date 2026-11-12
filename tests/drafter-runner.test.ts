import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeDraftWriter, type DraftRequest } from "@/lib/claude/drafter";

const req: DraftRequest = {
  businessContext: "奈良の茶園",
  playbooks: {},
  category: "order",
  language: "ja",
  summary: "注文の発送状況の問い合わせ",
  senderName: "山田",
  senderEmail: "yamada@example.jp",
  knownContact: true,
  contactNotes: "",
  contactSummary: "",
  signature: "悠三堂 礒﨑",
  thread: [{ from: "山田 <yamada@example.jp>", date: "11月12日", text: "#1001 はいつ届きますか", fromUs: false }],
  now: "11月12日(木) 9:00",
  tools: {
    shop: {
      searchProducts: async () => "",
      findOrders: async (q) => `注文 #1001 発送: FULFILLED 追跡: ヤマト 1234（${q.orderNumber}）`,
      policies: async () => "",
    },
    calendar: null,
  },
  wantSlots: false,
  instruction: null,
  previousDraft: null,
};

function reply(content: unknown[], stop_reason: string) {
  return new Response(
    JSON.stringify({
      id: `msg_${Math.random()}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("返信下書きのツールランナー", () => {
  it("Claude が注文を調べてから書き、調べたことを返す", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length === 1) {
          return reply([{ type: "tool_use", id: "tu_1", name: "find_orders", input: { order_number: "1001" } }], "tool_use");
        }
        return reply(
          [{ type: "text", text: "<notes>注文 #1001 は発送済み。</notes><draft>山田様\nヤマト 1234 で発送済みです。\n悠三堂 礒﨑</draft>" }],
          "end_turn",
        );
      }),
    );
    const result = await new ClaudeDraftWriter().write(req);
    expect(result.body).toContain("ヤマト 1234 で発送済み");
    expect(result.lookups).toEqual(["Shopify 注文検索（1001）"]);
    // 1回目：ツールとモデル・フォールバックの指定
    expect(bodies[0].model).toBe("claude-opus-5-5");
    expect(bodies[0].fallbacks).toBe("default");
    expect((bodies[0].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["search_products", "find_orders", "shop_policies"]);
    // 2回目：ツールの結果を Claude に返している
    const last = (bodies[1].messages as Array<{ role: string; content: unknown }>).at(-1)!;
    expect(JSON.stringify(last.content)).toContain("FULFILLED");
  });
});
