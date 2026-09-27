import type { Db } from "./index";
import { addressMap, playbooks, settings } from "./schema";
import type { Category, DateKind, Folder } from "../domain";

/** 仕様書 7章の用途別アドレス（ローカル部）。ドメインは ALLOWED_DOMAIN を付ける */
export const DEFAULT_ADDRESSES: Array<{
  local: string;
  folder: Folder;
  contentDecides?: boolean;
  note: string;
}> = [
  { local: "keiri", folder: "keiri", note: "請求書・領収書・支払通知・税理士・銀行" },
  { local: "invoice", folder: "keiri", note: "取引先からの請求書 PDF 専用" },
  { local: "wholesale", folder: "wholesale", note: "新規卸問合せ・カタログ・サンプル・発注" },
  { local: "order", folder: "order", note: "Shopify 注文の問合せ・配送変更・返品" },
  { local: "tour", folder: "tour", note: "茶ツアー予約・日程・人数・料金" },
  { local: "cafe", folder: "cafe", note: "古民家カフェの営業・予約・問合せ" },
  { local: "intern", folder: "intern", note: "インターン・WWOOF 応募・面談・受入れ" },
  { local: "press", folder: "press", note: "取材・イベント・提携・講演" },
  { local: "sake", folder: "sake", note: "和以為尊・PEACE の問合せ" },
  { local: "kyokai", folder: "kyokai", note: "日本自然茶協会" },
  { local: "info", folder: "general", contentDecides: true, note: "総合窓口。内容で業務フォルダへ" },
  { local: "isozaki", folder: "personal", contentDecides: true, note: "代表の個人アドレス" },
];

export interface Signatures {
  ja: string;
  en: string;
  /** 送信元アドレスごとの上書き */
  byAddress: Record<string, { ja?: string; en?: string }>;
}

export interface BusinessHours {
  /** 0=日 … 6=土 */
  days: number[];
  start: string;
  end: string;
  slotMinutes: number;
}

export type CalendarMap = Record<DateKind, string>;

export type AutoDraftMap = Record<Folder, boolean>;

/** freee 会計との連携（会社で1つ）。リフレッシュトークンは使うたびに変わるので必ず保存し直す */
export interface FreeeSetting {
  refreshTokenEnc: string | null;
  companyId: number | null;
  companyName: string | null;
  companies: Array<{ id: number; name: string }>;
  connectedBy: string | null;
  connectedAt: string | null;
}

export const DEFAULT_FREEE: FreeeSetting = {
  refreshTokenEnc: null,
  companyId: null,
  companyName: null,
  companies: [],
  connectedBy: null,
  connectedAt: null,
};

/** 通知：urgent = 至急の要返信だけ、replies = 要返信すべて、off = 通知しない */
export interface NotifySetting {
  mode: "urgent" | "replies" | "off";
}

export const DEFAULT_NOTIFY: NotifySetting = { mode: "urgent" };

export const DEFAULT_SIGNATURES: Signatures = {
  ja: [
    "─────────────",
    "株式会社悠三堂　礒﨑遼太郎",
    "Tel: 080-1409-4139　Mail: isozaki@yusando.com",
    "Web: https://yusando.com",
    "─────────────",
  ].join("\n"),
  en: [
    "─────────────",
    "Ryotaro Isozaki",
    "Yusando Inc.",
    "yusando.com",
    "Natural Agriculture",
    "─────────────",
  ].join("\n"),
  byAddress: {},
};

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  days: [1, 2, 3, 4, 5, 6],
  start: "09:00",
  end: "17:00",
  slotMinutes: 60,
};

export const DEFAULT_CALENDAR_MAP: CalendarMap = {
  visit: "primary",
  interview: "primary",
  payment_due: "primary",
  delivery: "primary",
  event: "primary",
};

export const DEFAULT_AUTO_DRAFT: AutoDraftMap = {
  keiri: false,
  wholesale: true,
  order: true,
  tour: true,
  intern: true,
  press: true,
  product: true,
  sake: true,
  kyokai: true,
  cafe: true,
  backer: true,
  general: true,
  info: false,
  personal: true,
};

export const DEFAULT_BUSINESS_CONTEXT = `株式会社悠三堂（Yusando Co., Ltd.）
- 奈良県・都祁（つげ）地域の自然栽培の茶園。2015年から無農薬・無肥料。代表取締役は礒﨑遼太郎（isozaki@yusando.com）。
- 理念は自然栽培と「自然経営」。代表は自然茶道（本然無作）を提唱し、一般社団法人日本自然茶協会の代表理事も務める。
- 茶：煎茶・抹茶（石臼挽き）・ほうじ茶・釜炒り茶・烏龍茶・紅茶・白茶、満月萌茶・はなばんちゃなど。
- 茶ツアーを茶園で実施。
- 酒：和以為尊／PEACE（自然栽培米の酒）。酒類販売業免許はあるが、販売・発送できる先に制限があるため、定型外は必ず【要確認】にする。
- 古民家カフェ：DIY 改修中で開店準備中。開店日は確定していないので断定しない。
- Shopify で日英仏中の4言語のオンラインストアを運営。海外の問合せも主要な業務として扱う。

既知の取引先（関係が続いているので、改まりすぎない）
- Benjamin（Adventcha、オーストラリア）：抹茶の卸先
- TEA TEA TEA LLC、Matchado：海外の卸先
- Jeff、Vincent：現地チーム。Axel：フランスからのインターン
- 悠三堂水田部：京都・山城の米づくりコミュニティ

在庫・価格・日付・認証・生産量など確認していない事実は書かない。`;

export const DEFAULT_PLAYBOOKS: Record<Category, string> = {
  wholesale: `最も重要なカテゴリ。早く、温かく、次の一歩を具体的に。商取引の条件はすべて【要確認】にする。
- 冒頭で関心への感謝と、依頼内容（商品・数量・届け先）を理解したことを一行で伝える。
- 悠三堂の商品・自然栽培であること・海外にも卸していることなど、拘束力のない一般情報を添える。
- 【要確認】：価格、MOQ、リードタイム、サンプルの可否、配送条件。
- 次の一歩を示す：価格表、サンプル、短い打合せのいずれか。
- 既知の取引先（Adventcha/Benjamin、TEA TEA TEA、Matchado）には改まった前置きを省き、これまでの関係の続きとして書く。
例（英語・新規・抹茶5kg）:
"Hi [Name], thank you for reaching out — wonderful to hear you're interested in our Uji matcha. We'd be glad to supply 5kg. So I can send accurate details: is this for resale or in-house use, and where would it ship to? Our matcha is stone-milled from natural-cultivation tea. I can put together pricing and lead time — 【要確認：kg単価・MOQ】 — and send a sample if useful. Looking forward to it. — Ryotaro"`,
  order: `- 注文情報が渡されていれば注文番号に触れる。状況や追跡番号を推測で書かない。
- 冒頭で具体的な答え（状況・次に何が起きるか）を書く。
- 【要確認】：返金、交換、発送中の住所変更、補償。
- 短く安心させる。謝りすぎない。`,
  tour: `- 茶園を案内できることを喜んでいると伝える。
- 日程・人数・言語・関心など、計画を決める条件を確認する。
- 【要確認】：確定の日時と料金。約束せず提案する。
- 空き時間の候補が渡されていれば 2〜3 案を示し、相手が選ぶだけにする。`,
  cafe: `- 正直に「開店準備中」と伝える。開店日は確認されていない限り断定しない。
- DIY 改修で場所ができていく楽しさは伝えてよいが、守れない約束はしない。
- 予約の依頼には感謝し、まだ予約を受けていないこと（または【要確認】）と、開店したら知らせることを伝える。`,
  backer: `- まず支援への心からの感謝。磨かれた文章より誠実さ。
- リターンの状況を正直に伝える。
- 【要確認】：遅れや日付の約束。`,
  press: `- 開かれた姿勢で。丁寧な取材や提携は歓迎している。
- 媒体名や企画に具体的に触れ、定型文に見えないようにする。
- 【要確認】：日程、時間や資源の約束、独占、使用権。日時は決めずに候補を探すと伝える。`,
  product: `- 知識と温かさを持って答える。ブランドが最も伝わる場面。
- 自然栽培の考え方は売り込みでなく自然に。
- カテキン量・収穫日・認証など、知らない仕様を作らない。確認すると伝える。
- 淹れ方の案内は喜ばれる。`,
  sake: `- 自然栽培米の酒としての物語を温かく。京都の茶道の懐石で披露されたことは話題にしてよい。
- 【要確認】を強く：酒類の免許により販売・発送できる先に制限がある。相手先・届け先で可能か確認されるまで販売や発送を約束しない。`,
  kyokai: `- 代表理事として協会を代表して書く。少し改まった文体にする。
- 入会や提携の問合せには歓迎し次の手順を示す。正式な約束に当たる部分は【要確認】。`,
  intern: `- 応募への感謝。受入れの可否は決めずに、時期・期間・希望する作業・滞在方法を確認する。
- 【要確認】：受入れ可否、期間、宿泊、費用、面談日時。
- 面談の候補時間が渡されていれば 2〜3 案を示す。`,
  keiri: `- 事務的に簡潔に。受領確認や不足書類の依頼が中心。
- 【要確認】：金額、支払日、振込先の変更、契約に関わること。`,
  general: `- 効率よく短く。仕入先・物流・経理（freee）・事務連絡など。
- 相手の簡潔さに合わせる。定型業務にブランドの飾りは要らない。
- お金や契約に関わることは【要確認】。`,
  info: `- 基本的に返信不要。返信する場合は短く事務的に。`,
};

/** 既定値を入れる。既にある行は上書きしない（何度実行してもよい）。 */
export async function seedDefaults(db: Db, domain: string): Promise<void> {
  const d = domain.toLowerCase();
  await db
    .insert(addressMap)
    .values(
      DEFAULT_ADDRESSES.map((a) => ({
        address: `${a.local}@${d}`,
        folder: a.folder,
        contentDecides: a.contentDecides ?? false,
        note: a.note,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(playbooks)
    .values(Object.entries(DEFAULT_PLAYBOOKS).map(([category, guidance]) => ({ category, guidance })))
    .onConflictDoNothing();

  const defaults: Record<string, unknown> = {
    signatures: DEFAULT_SIGNATURES,
    businessHours: DEFAULT_BUSINESS_HOURS,
    calendarMap: DEFAULT_CALENDAR_MAP,
    autoDraft: DEFAULT_AUTO_DRAFT,
    businessContext: DEFAULT_BUSINESS_CONTEXT,
  };
  await db
    .insert(settings)
    .values(Object.entries(defaults).map(([key, value]) => ({ key, value })))
    .onConflictDoNothing();
}
