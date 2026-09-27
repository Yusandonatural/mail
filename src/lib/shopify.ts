/**
 * Shopify Admin API（読み取りのみ）。注文・配送カテゴリの下書きに、相手の最近の注文を渡す。
 * SHOPIFY_STORE_DOMAIN と SHOPIFY_ADMIN_TOKEN が無ければ何もしない。
 */
export interface OrderLookup {
  ordersForEmail(email: string): Promise<string | null>;
}

interface OrderNode {
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { nodes: Array<{ name: string; quantity: number }> };
  fulfillments: Array<{ status: string; trackingInfo: Array<{ number: string | null; company: string | null }> }>;
}

const QUERY = `query Orders($q: String!) {
  orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes {
      name createdAt displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 10) { nodes { name quantity } }
      fulfillments(first: 3) { status trackingInfo { number company } }
    }
  }
}`;

export function formatOrders(nodes: OrderNode[]): string | null {
  if (!nodes.length) return null;
  return nodes
    .map((o) => {
      const items = o.lineItems.nodes.map((i) => `${i.name}×${i.quantity}`).join("、");
      const tracking = o.fulfillments
        .flatMap((f) => f.trackingInfo.map((t) => `${t.company ?? ""} ${t.number ?? ""}`.trim()))
        .filter(Boolean)
        .join("、");
      return [
        `注文 ${o.name}（${o.createdAt.slice(0, 10)}）`,
        `  金額: ${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}`,
        `  支払: ${o.displayFinancialStatus ?? "不明"} / 発送: ${o.displayFulfillmentStatus ?? "不明"}`,
        `  商品: ${items}`,
        tracking ? `  追跡: ${tracking}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

export class ShopifyOrderLookup implements OrderLookup {
  constructor(
    private domain: string,
    private token: string,
    private version = process.env.SHOPIFY_API_VERSION || "2026-07",
  ) {}

  async ordersForEmail(email: string): Promise<string | null> {
    const res = await fetch(`https://${this.domain}/admin/api/${this.version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.token },
      body: JSON.stringify({ query: QUERY, variables: { q: `email:${email}` } }),
    });
    if (!res.ok) throw new Error(`Shopify API ${res.status}`);
    const json = (await res.json()) as { data?: { orders?: { nodes: OrderNode[] } } };
    return formatOrders(json.data?.orders?.nodes ?? []);
  }
}

export function orderLookupFromEnv(): OrderLookup | null {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  return domain && token ? new ShopifyOrderLookup(domain, token) : null;
}
