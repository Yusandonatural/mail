/**
 * 業務カテゴリ・フォルダ・状態ラベルの定義（仕様書 4章・7章）。
 * フォルダは Gmail ラベル「悠三堂/<フォルダ名>」と 1 対 1 に対応する。
 */

export const CATEGORIES = [
  "keiri",
  "wholesale",
  "order",
  "tour",
  "intern",
  "press",
  "product",
  "sake",
  "kyokai",
  "cafe",
  "backer",
  "general",
  "info",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  keiri: "経理・支払・請求書",
  wholesale: "卸売",
  order: "注文・配送",
  tour: "茶ツアー",
  intern: "インターン",
  press: "取材・コラボ",
  product: "商品・淹れ方",
  sake: "酒",
  kyokai: "協会",
  cafe: "カフェ",
  backer: "リターン",
  general: "一般・取引先",
  info: "情報・ニュースレター",
};

/** 個人アドレス宛てで、まだ業務フォルダが決まっていないメールの置き場 */
export const PERSONAL_FOLDER = "個人";

export type Folder = Category | typeof PERSONAL_FOLDER_KEY;
export const PERSONAL_FOLDER_KEY = "personal" as const;

export const FOLDER_KEYS: Folder[] = [...CATEGORIES, PERSONAL_FOLDER_KEY];

export function folderName(folder: Folder): string {
  return folder === PERSONAL_FOLDER_KEY ? PERSONAL_FOLDER : CATEGORY_LABELS[folder];
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export function isFolder(value: unknown): value is Folder {
  return value === PERSONAL_FOLDER_KEY || isCategory(value);
}

export const LABEL_ROOT = "悠三堂";
export const STATUS_LABEL_ROOT = "状態";

export function folderLabelName(folder: Folder): string {
  return `${LABEL_ROOT}/${folderName(folder)}`;
}

export const STATUS_LABELS = {
  needsReply: `${STATUS_LABEL_ROOT}/要返信`,
  draftReady: `${STATUS_LABEL_ROOT}/下書きあり`,
  needsReview: `${STATUS_LABEL_ROOT}/要確認`,
  done: `${STATUS_LABEL_ROOT}/対応済`,
} as const;

export type StatusLabelKey = keyof typeof STATUS_LABELS;

export const LANGUAGES = ["ja", "en", "fr", "zh"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  ja: "日本語",
  en: "English",
  fr: "Français",
  zh: "中文",
};

export const URGENCIES = ["high", "normal", "low"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** 日程候補の種別（仕様書 4章 dates[]） */
export const DATE_KINDS = ["visit", "interview", "payment_due", "delivery", "event"] as const;
export type DateKind = (typeof DATE_KINDS)[number];

export const DATE_KIND_LABELS: Record<DateKind, string> = {
  visit: "訪問・来客",
  interview: "面談・面接",
  payment_due: "支払期日",
  delivery: "納期",
  event: "イベント",
};

/** 分類の信頼度がこれ未満なら「要確認」を付ける（仕様書 4章） */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;

export const MESSAGE_STATUSES = ["new", "draft_ready", "replied", "done", "skipped"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const TIMEZONE = "Asia/Tokyo";
