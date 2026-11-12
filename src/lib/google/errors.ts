/**
 * Google API（gaxios）のエラーの見分け。ジョブを再試行するか、諦めるか、ログインし直してもらうかを決める。
 */

interface GoogleErrorLike {
  code?: number | string;
  status?: number;
  message?: string;
  errors?: Array<{ reason?: string }>;
  response?: { status?: number; data?: unknown };
}

export function googleStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as GoogleErrorLike;
  const code = typeof e.code === "number" ? e.code : Number(e.code);
  return e.status ?? e.response?.status ?? (Number.isFinite(code) ? code : undefined);
}

function reasons(err: GoogleErrorLike): string[] {
  const data = err.response?.data as { error?: { errors?: Array<{ reason?: string }> } } | undefined;
  const list = [...(err.errors ?? []), ...(typeof data?.error === "object" ? (data.error.errors ?? []) : [])];
  return list.map((r) => r.reason ?? "").filter(Boolean);
}

/**
 * リフレッシュトークンが無効になった（本人が連携を外した・パスワードを変えた・長く使わず期限が切れた）。
 * 何度やり直しても通らないので、ログインし直してもらう
 */
export function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as GoogleErrorLike;
  const data = e.response?.data as { error?: unknown } | undefined;
  return data?.error === "invalid_grant" || /\binvalid_grant\b/.test(e.message ?? "");
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);

/** 時間をおけば通る失敗（混雑・一時的な障害・通信エラー）。Gmail は使いすぎを 403 で返すこともある */
export function isGoogleTransient(err: unknown): boolean {
  if (!err || typeof err !== "object" || isInvalidGrant(err)) return false;
  const e = err as GoogleErrorLike;
  if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
  const status = googleStatus(err);
  if (status === undefined) return false;
  if (status === 429 || status === 408 || status >= 500) return true;
  return status === 403 && reasons(e).some((r) => RATE_LIMIT_REASONS.has(r));
}

/** やり直しても結果が変わらない失敗（メールが消えた・権限が足りない・要求が正しくない） */
export function isGooglePermanent(err: unknown): boolean {
  if (!err || typeof err !== "object" || isInvalidGrant(err) || isGoogleTransient(err)) return false;
  // Google API のエラー（gaxios）だけを見る。DB などほかのエラーのコードと取り違えない
  if (!("response" in err) && !("errors" in err)) return false;
  const status = googleStatus(err);
  return status === 400 || status === 403 || status === 404 || status === 410;
}
