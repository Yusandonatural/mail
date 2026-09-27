import { eq, sql } from "drizzle-orm";
import type { Db } from "./db";
import { settings } from "./db/schema";
import { decryptSecret, encryptSecret } from "./crypto";
import { getSetting, putSetting } from "./settings";

/**
 * freee 会計 API。請求書・領収書の添付をファイルボックス（証憑）に送る（仕様書 10章・12章 P4）。
 * 取引の登録は行わない。仕訳は経理担当が freee の画面で行う。
 */
export const FREEE_AUTHORIZE_URL = "https://accounts.secure.freee.co.jp/public_api/authorize";
export const FREEE_TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
export const FREEE_API = "https://api.freee.co.jp";

/** freee のファイルボックスが受け付ける形式 */
export const FREEE_RECEIPT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif"]);

export class FreeeNotConnectedError extends Error {
  constructor() {
    super("freee と連携していません。設定画面から連携してください");
  }
}

export interface FreeeReceiptInput {
  companyId: number;
  filename: string;
  mimeType: string;
  data: Buffer;
  description: string;
  issueDate: string;
}

export interface FreeeApi {
  companies(): Promise<Array<{ id: number; name: string }>>;
  uploadReceipt(input: FreeeReceiptInput): Promise<{ id: string }>;
}

type FetchFn = typeof fetch;

export function freeeConfigured(): boolean {
  return Boolean(process.env.FREEE_CLIENT_ID && process.env.FREEE_CLIENT_SECRET);
}

export function freeeRedirectUri(): string {
  return `${process.env.APP_BASE_URL}/api/freee/callback`;
}

export function freeeAuthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.FREEE_CLIENT_ID ?? "",
    redirect_uri: freeeRedirectUri(),
    response_type: "code",
    state,
    prompt: "select_company",
  });
  return `${FREEE_AUTHORIZE_URL}?${p}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(body: Record<string, string>, fetchImpl: FetchFn): Promise<TokenResponse> {
  const res = await fetchImpl(FREEE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.FREEE_CLIENT_ID ?? "",
      client_secret: process.env.FREEE_CLIENT_SECRET ?? "",
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`freee の認証に失敗しました（${res.status}）`);
  return (await res.json()) as TokenResponse;
}

export async function exchangeFreeeCode(code: string, fetchImpl: FetchFn = fetch): Promise<TokenResponse> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: freeeRedirectUri() }, fetchImpl);
}

let cachedAccess: { token: string; expiresAt: number; refreshEnc: string } | null = null;

export function clearFreeeTokenCache(): void {
  cachedAccess = null;
}

/**
 * アクセストークンを返す。freee のリフレッシュトークンは1回使うと無効になるので、
 * 新しいものを必ず保存する。別のサーバーが先に更新していた場合はそちらを読み直してやり直す。
 */
export async function freeeAccessToken(db: Db, fetchImpl: FetchFn = fetch, retried = false): Promise<string> {
  const s = await getSetting(db, "freee");
  if (!s.refreshTokenEnc) throw new FreeeNotConnectedError();
  if (cachedAccess && cachedAccess.refreshEnc === s.refreshTokenEnc && cachedAccess.expiresAt > Date.now() + 60_000) {
    return cachedAccess.token;
  }
  let token: TokenResponse;
  try {
    token = await tokenRequest({ grant_type: "refresh_token", refresh_token: decryptSecret(s.refreshTokenEnc) }, fetchImpl);
  } catch (err) {
    const again = await getSetting(db, "freee");
    if (!retried && again.refreshTokenEnc && again.refreshTokenEnc !== s.refreshTokenEnc) {
      return freeeAccessToken(db, fetchImpl, true);
    }
    throw err;
  }
  const newEnc = encryptSecret(token.refresh_token);
  // 読んだときと同じトークンのときだけ書き換える（同時に更新されたら後勝ちにしない）
  await db
    .update(settings)
    .set({ value: { ...s, refreshTokenEnc: newEnc }, updatedAt: new Date() })
    .where(sql`${settings.key} = 'freee' and ${settings.value}->>'refreshTokenEnc' = ${s.refreshTokenEnc}`);
  cachedAccess = { token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000, refreshEnc: newEnc };
  return token.access_token;
}

export async function saveFreeeConnection(
  db: Db,
  refreshToken: string,
  companies: Array<{ id: number; name: string }>,
  connectedBy: string,
): Promise<void> {
  const first = companies[0] ?? null;
  await putSetting(db, "freee", {
    refreshTokenEnc: encryptSecret(refreshToken),
    companyId: first?.id ?? null,
    companyName: first?.name ?? null,
    companies,
    connectedBy,
    connectedAt: new Date().toISOString(),
  });
  clearFreeeTokenCache();
}

export async function disconnectFreee(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, "freee"));
  clearFreeeTokenCache();
}

export class FreeeHttpApi implements FreeeApi {
  constructor(
    private token: () => Promise<string>,
    private fetchImpl: FetchFn = fetch,
  ) {}

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(`${FREEE_API}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`freee API ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return res.json();
  }

  async companies() {
    const json = (await this.call("/api/1/companies", { method: "GET" })) as {
      companies?: Array<{ id: number; display_name?: string; name?: string }>;
    };
    return (json.companies ?? []).map((c) => ({ id: c.id, name: c.display_name || c.name || String(c.id) }));
  }

  async uploadReceipt(input: FreeeReceiptInput) {
    const form = new FormData();
    form.set("company_id", String(input.companyId));
    form.set("description", input.description.slice(0, 255));
    form.set("issue_date", input.issueDate);
    form.set("receipt", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.filename);
    const json = (await this.call("/api/1/receipts", { method: "POST", body: form })) as { receipt?: { id: number } };
    if (!json.receipt?.id) throw new Error("freee から証憑の ID が返りませんでした");
    return { id: String(json.receipt.id) };
  }
}

export function freeeApiFor(db: Db): FreeeApi {
  return new FreeeHttpApi(() => freeeAccessToken(db));
}
