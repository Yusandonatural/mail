import { describe, expect, it, vi } from "vitest";
import { calendarTools } from "@/lib/drafts";
import { draftTools, userPrompt, type DraftRequest } from "@/lib/claude/drafter";
import { formatProducts, htmlToPlain } from "@/lib/shopify";
import { freeWindows } from "@/lib/slots";
import { fromJst } from "@/lib/time";
import type { CalendarApi } from "@/lib/google/calendar-api";
import { putSetting } from "@/lib/settings";
import { testDb } from "./helpers/db";

const HOURS = { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5], slotMinutes: 60 };

function fakeCalendar(): CalendarApi {
  // 2026-11-20(金) 10:00〜12:00 に茶ツアー
  const tour = { start: fromJst(2026, 11, 20, 10), end: fromJst(2026, 11, 20, 12) };
  return {
    listCalendars: async () => [],
    freeBusy: async () => [tour],
    listEvents: async () => [
      { id: "e1", calendarId: "c", summary: "茶ツアー（山田様）", start: tour.start.toISOString(), end: tour.end.toISOString(), allDay: false, description: "", htmlLink: null },
    ],
    insertEvent: async () => ({ id: "x", htmlLink: null }),
    patchEvent: async () => {},
  };
}

async function dbWithHours() {
  const db = await testDb();
  await putSetting(db, "businessHours", HOURS as never);
  await putSetting(db, "calendarMap", { tour: "c" } as never);
  return db;
}

describe("下書き用のカレンダー", () => {
  it("営業時間から予定を除いた空きを出す", () => {
    const day = fromJst(2026, 11, 20);
    const busy = [{ start: fromJst(2026, 11, 20, 10), end: fromJst(2026, 11, 20, 12) }];
    const w = freeWindows(busy, HOURS, day);
    expect(w.map((x) => [x.start.toISOString(), x.end.toISOString()])).toEqual([
      [fromJst(2026, 11, 20, 9).toISOString(), fromJst(2026, 11, 20, 10).toISOString()],
      [fromJst(2026, 11, 20, 12).toISOString(), fromJst(2026, 11, 20, 17).toISOString()],
    ]);
    expect(freeWindows(busy, HOURS, fromJst(2026, 11, 22))).toEqual([]); // 日曜は休み
  });

  it("指定した日の予定と空き、休みの日を書き出す", async () => {
    const db = await dbWithHours();
    const out = await calendarTools(db, fakeCalendar(), fromJst(2026, 11, 12, 12)).check("2026-11-20", "2026-11-22");
    expect(out).toContain("11月20日(金): 予定 10:00〜12:00 予定あり。空き 9:00〜10:00、12:00〜17:00");
    // 予定の名前（相手の名前など）は Claude に渡さない
    expect(out).not.toContain("山田");
    expect(out).toContain("11月22日(日): 休み。");
    expect(await calendarTools(db, fakeCalendar()).check("来週", "2026-11-20")).toContain("YYYY-MM-DD");
  });

  it("空き候補は予定と重ならず、別々の日から選ぶ", async () => {
    const db = await dbWithHours();
    const out = await calendarTools(db, fakeCalendar(), fromJst(2026, 11, 12, 12)).freeSlots({ fromDate: "2026-11-20", count: 2 });
    expect(out.split("\n")).toEqual(["- 11月20日(金) 9:00〜10:00", "- 11月23日(月) 9:00〜10:00"]);
  });
});

describe("下書き用のツール", () => {
  it("失敗してもエラーにせず【要確認】を促し、調べたことを記録する", async () => {
    const log: string[] = [];
    const tools = draftTools(
      {
        shop: {
          searchProducts: async () => "朝摘み煎茶 1,620円 / 在庫 12",
          findOrders: async () => {
            throw new Error("Shopify API 401");
          },
          policies: async () => "",
        },
        calendar: null,
      },
      log,
      "a@b.c",
    );
    expect(tools.map((t) => t.name)).toEqual(["search_products", "find_orders", "shop_policies"]);
    const search = tools.find((t) => t.name === "search_products")!;
    const orders = tools.find((t) => t.name === "find_orders")!;
    expect(await (search.run as (i: unknown) => Promise<string>)({ query: "煎茶" })).toContain("在庫 12");
    expect(await (orders.run as (i: unknown) => Promise<string>)({})).toContain("【要確認】");
    expect(log).toEqual(["Shopify 商品検索「煎茶」", "Shopify 注文検索（a@b.c）（取得できませんでした）"]);
  });

  it("設定の無い調べものは渡さず、プロンプトにも書かない", () => {
    expect(draftTools({ shop: null, calendar: null }, [])).toEqual([]);
    const req = {
      businessContext: "",
      playbooks: {},
      category: null,
      language: "ja",
      summary: "s",
      senderName: "Ben",
      senderEmail: "ben@x.example",
      knownContact: false,
      contactNotes: "",
      contactSummary: "",
      signature: "sig",
      thread: [],
      now: "11月12日(木) 9:00",
      tools: { shop: null, calendar: null },
      wantSlots: false,
      instruction: null,
      previousDraft: null,
    } satisfies DraftRequest;
    const p = userPrompt(req);
    expect(p).toContain("いまの日時（日本時間）: 11月12日(木) 9:00");
    expect(p).toContain("使える調べもの: なし");
    expect(p).toContain("<ben@x.example>");
  });
});

describe("Shopify の整形", () => {
  it("価格・在庫・ページを読める形にする", () => {
    const text = formatProducts([
      {
        title: "朝摘み煎茶",
        status: "ACTIVE",
        productType: "煎茶",
        onlineStoreUrl: "https://yusando.example/products/sencha",
        tracksInventory: true,
        variants: {
          nodes: [
            { title: "50g", price: "1620", sku: "S50", availableForSale: true, inventoryQuantity: 12 },
            { title: "100g", price: "2980", sku: null, availableForSale: false, inventoryQuantity: 0 },
          ],
        },
      },
    ]);
    expect(text).toContain("朝摘み煎茶 [煎茶]");
    expect(text).toContain("50g: 1620円（SKU S50） / 在庫 12");
    expect(text).toContain("100g: 2980円 / 販売停止・売り切れ");
    expect(text).toContain("ページ: https://yusando.example/products/sencha");
    expect(formatProducts([])).toBeNull();
    expect(htmlToPlain("<p>送料は<b>全国一律</b>&amp;無料</p><p>返品は7日以内</p>")).toBe("送料は全国一律&無料\n返品は7日以内");
  });
});

describe("Shopify の注文検索", () => {
  it("お客様本人の注文だけを返し、他人の注文番号では中身を出さない", async () => {
    const { ShopifyStore } = await import("@/lib/shopify");
    const order = (name: string, email: string) => ({
      name,
      email,
      createdAt: "2026-11-01T00:00:00Z",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      totalPriceSet: { shopMoney: { amount: "3240", currencyCode: "JPY" } },
      lineItems: { nodes: [{ name: "朝摘み煎茶", quantity: 2 }] },
      fulfillments: [{ status: "SUCCESS", trackingInfo: [{ number: "1234", company: "ヤマト" }] }],
    });
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).variables.q as string;
      queries.push(q);
      const nodes = q.includes("#1001") ? [order("#1001", "other@example.com")] : [order("#1002", "Yamada@Example.jp")];
      return new Response(JSON.stringify({ data: { orders: { nodes } } }), { status: 200 });
    });
    const shop = new ShopifyStore("shop.example", "t");
    expect(await shop.findOrders({ customerEmail: "yamada@example.jp" })).toContain("注文 #1002");
    const other = await shop.findOrders({ customerEmail: "yamada@example.jp", orderNumber: "1001" });
    expect(other).not.toContain("朝摘み煎茶");
    expect(other).toContain("【要確認");
    expect(queries).toEqual(['email:"yamada@example.jp"', 'name:"#1001"']);
    vi.unstubAllGlobals();
  });
});

describe("下書き用の調べもので外に出さないもの", () => {
  it("終日の予定は種類だけを伝え、支払期限などの事務の予定は区別する", async () => {
    const { allDayKind } = await import("@/lib/drafts");
    expect(allDayKind("出張（東京・山田様）")).toBe("外出・休みなどの可能性");
    expect(allDayKind("支払期限：〇〇商事 請求書")).toBe("事務の予定（支払期限など）");
  });

  it("Shopify の商品検索は公開中の商品だけ", async () => {
    const { ShopifyStore } = await import("@/lib/shopify");
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).variables.q);
      const node = (title: string, status: string) => ({ title, status, productType: null, onlineStoreUrl: null, variants: { nodes: [] } });
      return new Response(JSON.stringify({ data: { products: { nodes: [node("朝摘み煎茶", "ACTIVE"), node("新作（未発表）", "DRAFT")] } } }), { status: 200 });
    });
    const out = await new ShopifyStore("shop.example", "t").searchProducts("煎茶 OR status:draft");
    expect(out).toContain("朝摘み煎茶");
    expect(out).not.toContain("未発表");
    expect(queries[0]).toBe("(煎茶 OR status:draft) AND status:active");
    vi.unstubAllGlobals();
  });
});
