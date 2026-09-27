import { z } from "zod";
import { CATEGORIES, DATE_KINDS, LANGUAGES, URGENCIES } from "../domain";

/** 二次分類で Claude に返させる JSON（仕様書 4章の表） */
export const ContentClassificationSchema = z.object({
  category: z.enum(CATEGORIES).describe("最も近い業務カテゴリ"),
  needs_reply: z.boolean().describe("悠三堂から返信が必要なら true"),
  urgency: z.enum(URGENCIES),
  language: z.enum(LANGUAGES).describe("送信者が書いた言語"),
  dates: z
    .array(
      z.object({
        kind: z.enum(DATE_KINDS),
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

export type ContentClassification = z.infer<typeof ContentClassificationSchema>;

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
