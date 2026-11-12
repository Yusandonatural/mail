/**
 * Shopify Admin API（読み取りのみ）。返信下書きを書く Claude が、必要なときに
 * 商品（価格・在庫・ページ）、相手の注文、ストアの規約（配送・返品）を調べるのに使う。
 * SHOPIFY_STORE_DOMAIN と SHOPIFY_ADMIN_TOKEN が無ければ使わない。
 */
export interface ShopInfo {
  /** キーワードで商品を探す（価格・在庫・バリエーション・ページの URL） */
  searchProducts(query: string): Promise<string>;
  /** メールアドレスか注文番号で注文を探す */
  findOrders(q: { email?: string; orderNumber?: string }): Promise<string>;
  /** 配送・返品・支払いなどストアの規約 */
  policies(): Promise<string>;
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

interface VariantNode {
  title: string;
  price: string;
  sku: string | null;
  availableForSale: boolean;
  inventoryQuantity?: number | null;
}

interface ProductNode {
  title: string;
  status: string;
  productType: string | null;
  onlineStoreUrl: string | null;
  totalInventory?: number | null;
  tracksInventory?: boolean;
  variants: { nodes: VariantNode[] };
}

const ORDERS = `query Orders($q: String!) {
  orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes {
      name createdAt displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 10) { nodes { name quantity } }
      fulfillments(first: 3) { status trackingInfo { number company } }
    }
  }
}`;

const PRODUCTS = (withInventory: boolean) => `query Products($q: String!) {
  products(first: 8, query: $q, sortKey: RELEVANCE) {
    nodes {
      title status productType onlineStoreUrl ${withInventory ? "totalInventory tracksInventory" : ""}
      variants(first: 10) { nodes { title price sku availableForSale ${withInventory ? "inventoryQuantity" : ""} } }
    }
  }
}`;

const POLICIES = `query { shop { name currencyCode shopPolicies { type title body } } }`;

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

export function formatProducts(nodes: ProductNode[]): string | null {
  if (!nodes.length) return null;
  return nodes
    .map((p) => {
      const stock = (v: VariantNode) => {
        if (!v.availableForSale) return "販売停止・売り切れ";
        if (typeof v.inventoryQuantity === "number" && p.tracksInventory !== false) {
          // 在庫切れでも販売を続ける設定（予約・取り寄せ）では 0 以下になる
          return v.inventoryQuantity > 0 ? `在庫 ${v.inventoryQuantity}` : "販売中（在庫数 0・取り寄せや予約の扱い）";
        }
        return "販売中";
      };
      const variants = p.variants.nodes
        .map((v) => `  - ${v.title === "Default Title" ? "標準" : v.title}: ${v.price}円${v.sku ? `（SKU ${v.sku}）` : ""} / ${stock(v)}`)
        .join("\n");
      return [
        `${p.title}${p.status !== "ACTIVE" ? `（${p.status === "DRAFT" ? "非公開" : "アーカイブ"}）` : ""}${p.productType ? ` [${p.productType}]` : ""}`,
        variants,
        p.onlineStoreUrl ? `  ページ: ${p.onlineStoreUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", yen: "¥", amp: "&" };

/** 規約の本文（HTML）を読める長さのテキストにする */
export function htmlToPlain(html: string, max = 1500): string {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n・")
    .replace(/<(br|\/p|\/div|\/tr|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // &amp; を最後に戻す（&amp;lt; を「<」にしてしまわないよう、一度に置き換える）
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…（以下省略）` : text;
}

/**
 * 注文検索の条件（Shopify の検索構文）。全角の「＃１００１」も直し、値は引用符で囲んで
 * 空白や記号で検索構文が崩れないようにする。注文番号は数字だけなら「#」を付ける。
 */
export function orderSearchQuery(q: { email?: string; orderNumber?: string }): string | null {
  const quote = (v: string) => `"${v.replace(/["\\]/g, "")}"`;
  const terms: string[] = [];
  const num = q.orderNumber?.normalize("NFKC").replace(/\s+/g, "").replace(/^(注文番号|order)[:：]?/i, "");
  if (num) terms.push(`name:${quote(/^\d+$/.test(num) ? `#${num}` : num)}`);
  const email = q.email?.normalize("NFKC").trim().toLowerCase();
  if (email) terms.push(`email:${quote(email)}`);
  return terms.length ? terms.join(" OR ") : null;
}

class ShopifyError extends Error {}

export class ShopifyStore implements ShopInfo {
  private policyCache: { at: number; text: string } | null = null;

  constructor(
    private domain: string,
    private token: string,
    private version = process.env.SHOPIFY_API_VERSION || "2026-07",
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`https://${this.domain}/admin/api/${this.version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.token },
      body: JSON.stringify({ query, variables }),
      // 応答が無いまま下書き全体が止まらないように
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new ShopifyError(`Shopify API ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new ShopifyError(json.errors.map((e) => e.message).join(" / "));
    if (!json.data) throw new ShopifyError("Shopify から空の応答");
    return json.data;
  }

  async searchProducts(query: string): Promise<string> {
    const q = query.trim().slice(0, 100);
    let nodes: ProductNode[];
    try {
      nodes = (await this.gql<{ products: { nodes: ProductNode[] } }>(PRODUCTS(true), { q })).products.nodes;
    } catch (err) {
      // 在庫を読む権限（read_inventory）が無いトークンでは、在庫抜きで探し直す
      if (!(err instanceof ShopifyError) || !/inventory|access/i.test(err.message)) throw err;
      nodes = (await this.gql<{ products: { nodes: ProductNode[] } }>(PRODUCTS(false), { q })).products.nodes;
    }
    return formatProducts(nodes) ?? `「${q}」に当たる商品は見つかりませんでした。`;
  }

  async findOrders(q: { email?: string; orderNumber?: string }): Promise<string> {
    const query = orderSearchQuery(q);
    if (!query) return "メールアドレスか注文番号を指定してください。";
    const data = await this.gql<{ orders: { nodes: OrderNode[] } }>(ORDERS, { q: query });
    return formatOrders(data.orders.nodes) ?? "該当する注文は見つかりませんでした。";
  }

  async policies(): Promise<string> {
    if (this.policyCache && Date.now() - this.policyCache.at < 3600_000) return this.policyCache.text;
    const data = await this.gql<{
      shop: { name: string; currencyCode: string; shopPolicies: Array<{ type: string; title: string; body: string }> };
    }>(POLICIES);
    const text =
      data.shop.shopPolicies.map((p) => `## ${p.title}\n${htmlToPlain(p.body)}`).join("\n\n") || "ストアの規約は登録されていません。";
    this.policyCache = { at: Date.now(), text };
    return text;
  }
}

let store: ShopifyStore | null | undefined;

export function shopFromEnv(): ShopInfo | null {
  if (store !== undefined) return store;
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  store = domain && token ? new ShopifyStore(domain, token) : null;
  return store;
}
