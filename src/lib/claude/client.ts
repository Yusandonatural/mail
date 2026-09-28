import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** モデルは環境変数で差し替えられる（仕様書 5章の表が既定値） */
export const MODELS = {
  draft: process.env.CLAUDE_DRAFT_MODEL || "claude-opus-5",
  classify: process.env.CLAUDE_CLASSIFY_MODEL || "claude-haiku-4-5",
  summarize: process.env.CLAUDE_SUMMARY_MODEL || "claude-haiku-4-5",
};

/** Claude が安全上の理由で応答しなかった（リトライしても同じ結果になる） */
export class ClaudeRefusalError extends Error {
  constructor(detail: string) {
    super(`Claude が応答を控えました: ${detail}`);
  }
}

/** メール本文など外部から来たテキストを、指示と誤解されない形で包む */
export function asData(tag: string, text: string): string {
  const safe = text.replaceAll(`</${tag}>`, `</ ${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

/** 時間をおけば通る失敗（混雑・一時的な障害・通信エラー）か。ジョブを失敗扱いにせず再試行させる */
export function isRetryableApiError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return false;
}
