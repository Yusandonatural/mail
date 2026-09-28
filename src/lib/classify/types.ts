import { z } from "zod";
import { CATEGORIES, DATE_KINDS, LANGUAGES, URGENCIES, type Category, type DateKind, type Language, type Urgency } from "../domain";

/**
 * 二次分類で Claude に返させる JSON（仕様書 4章の表）。
 * SDK は JSON Schema の enum を説明文に落としてしまうため、Claude が一覧に無い値
 * （例：language "de"、category "tea_tour"）を返すことがある。スキーマでは文字列として受け取り、
 * normalizeClassification で既知の値に寄せる。ここで弾くと分類全体が失敗扱いになるため。
 */
const oneOf = (values: readonly string[], note: string) => z.string().describe(`${note}。次のいずれか: ${values.join(", ")}`);

export const RawClassificationSchema = z.object({
  category: oneOf(CATEGORIES, "最も近い業務カテゴリ"),
  needs_reply: z.boolean().describe("悠三堂から返信が必要なら true"),
  urgency: oneOf(URGENCIES, "緊急度"),
  language: oneOf(LANGUAGES, "送信者が書いた言語。それ以外の言語なら en"),
  dates: z
    .array(
      z.object({
        kind: oneOf(DATE_KINDS, "予定の種別"),
        title: z.string().describe("予定のタイトル案（日本語、20字程度）"),
        start: z.string().describe("ISO 8601。時刻がなければ YYYY-MM-DD。日本時間は +09:00"),
        end: z.string().nullable().describe("ISO 8601 または null"),
        all_day: z.boolean(),
        note: z.string().describe("本文の該当箇所の要約。候補の一つなら「第2希望」など"),
      }),
    )
    .describe("本文に書かれた日時の候補。無ければ空配列"),
  amount: z
    .object({ value: z.number(), currency: z.string().describe("JPY, USD など") })
    .nullable()
    .describe("請求・支払の金額。無ければ null"),
  due_date: z.string().nullable().describe("支払期限 YYYY-MM-DD。無ければ null"),
  summary: z.string().describe("日本語の1行要約（40字程度）"),
  accepts_proposed_time: z
    .boolean()
    .describe("こちらが以前に提案した日時を相手が承諾・確定している返信なら true"),
  confidence: z.number().describe("カテゴリ判定の自信 0〜1"),
});

export type RawClassification = z.infer<typeof RawClassificationSchema>;

export interface ContentClassification {
  category: Category;
  needs_reply: boolean;
  urgency: Urgency;
  language: Language;
  dates: Array<{ kind: DateKind; title: string; start: string; end: string | null; all_day: boolean; note: string }>;
  amount: { value: number; currency: string } | null;
  due_date: string | null;
  summary: string;
  accepts_proposed_time: boolean;
  confidence: number;
}

function pick<T extends string>(values: readonly T[], value: string, fallback: T): { value: T; known: boolean } {
  const v = value.trim().toLowerCase();
  const hit = values.find((x) => x === v);
  return hit ? { value: hit, known: true } : { value: fallback, known: false };
}

/** Claude の返答を既知の値に寄せる。カテゴリが一覧外なら「一般」にして自信を下げ、要確認に回す */
export function normalizeClassification(raw: RawClassification): ContentClassification {
  const category = pick(CATEGORIES, raw.category, "general");
  const conf = Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0.5;
  return {
    category: category.value,
    needs_reply: raw.needs_reply,
    urgency: pick(URGENCIES, raw.urgency, "normal").value,
    language: pick(LANGUAGES, raw.language, "en").value,
    dates: raw.dates
      .filter((d) => d.start)
      .map((d) => ({ ...d, kind: pick(DATE_KINDS, d.kind, "event").value })),
    amount: raw.amount && Number.isFinite(raw.amount.value) ? raw.amount : null,
    due_date: raw.due_date && /^\d{4}-\d{2}-\d{2}$/.test(raw.due_date) ? raw.due_date : null,
    summary: raw.summary,
    accepts_proposed_time: raw.accepts_proposed_time,
    confidence: category.known ? conf : Math.min(conf, 0.5),
  };
}

export interface ClassifierInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
  attachmentNames: string[];
  receivedAt: Date;
  stage1Folder: string | null;
}

export interface Classifier {
  classify(input: ClassifierInput): Promise<ContentClassification>;
}
