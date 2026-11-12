import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** モデルは環境変数で差し替えられる（仕様書 5章の表が既定値） */
export const MODELS = {
  draft: process.env.CLAUDE_DRAFT_MODEL || "claude-opus-5-5",
  classify: process.env.CLAUDE_CLASSIFY_MODEL || "claude-haiku-4-5",
  summarize: process.env.CLAUDE_SUMMARY_MODEL || "claude-haiku-4-5",
  translate: process.env.CLAUDE_TRANSLATE_MODEL || "claude-opus-5-5",
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

/** Claude の API エラーを、画面で読める理由にする（キーや残高の問題は利用者が直せる） */
export function describeClaudeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const msg = err.message ?? "";
    if (err.status === 401) return "Anthropic の API キーが正しくありません（入れ替えたキーを確認してください）";
    if (err.status === 403) return "この API キーでは Claude を使う権限がありません";
    if (err.status === 404) return `モデルが見つかりません（${msg.slice(0, 120)}）`;
    if (err.status === 400 && /credit|balance/i.test(msg)) return "Anthropic の残高（クレジット）が足りません";
    return `Claude の呼び出しに失敗しました（${err.status ?? "?"}: ${msg.slice(0, 160)}）`;
  }
  if (err instanceof Error && /api[_ ]?key/i.test(err.message)) return "Anthropic の API キーが設定されていません";
  return err instanceof Error ? err.message.slice(0, 200) : String(err);
}
