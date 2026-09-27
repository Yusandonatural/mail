import { describe, expect, it } from "vitest";
import { buildQuery } from "@/lib/search";
import { formatOrders } from "@/lib/shopify";

describe("検索クエリ", () => {
  it("フォルダと期間を Gmail の演算子に直す", () => {
    expect(buildQuery("抹茶 from:ben", "wholesale", "2026-09-01", "2026-10-01")).toBe(
      '抹茶 from:ben label:"悠三堂/卸売" after:2026/09/01 before:2026/10/01',
    );
  });
  it("不正な値は無視する", () => {
    expect(buildQuery("", "nope", "x", "")).toBe("");
  });
});

describe("Shopify の注文の整形", () => {
  it("下書き用に読みやすい形にする", () => {
    const text = formatOrders([
      {
        name: "#1001",
        createdAt: "2026-09-20T01:00:00Z",
        displayFinancialStatus: "PAID",
        displayFulfillmentStatus: "FULFILLED",
        totalPriceSet: { shopMoney: { amount: "4800.0", currencyCode: "JPY" } },
        lineItems: { nodes: [{ name: "有機煎茶 100g", quantity: 2 }] },
        fulfillments: [{ status: "SUCCESS", trackingInfo: [{ number: "1234-5678", company: "ヤマト運輸" }] }],
      },
    ]);
    expect(text).toContain("注文 #1001（2026-09-20）");
    expect(text).toContain("有機煎茶 100g×2");
    expect(text).toContain("追跡: ヤマト運輸 1234-5678");
    expect(formatOrders([])).toBeNull();
  });
});
