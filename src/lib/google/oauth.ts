import { OAuth2Client } from "google-auth-library";
import { config } from "../config";
import { decryptSecret } from "../crypto";

/**
 * サーバーが使うスコープ。gmail.modify は読み取り・ラベル・下書きのため。
 * 送信はサーバーでは行わない（送信 API を呼ぶコードをサーバーに置かない。仕様書 11章）。
 */
export const SERVER_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

/** ブラウザで送信ボタンを押したときだけ要求するスコープ */
export const BROWSER_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export function redirectUri(): string {
  return `${config().APP_BASE_URL}/api/auth/callback`;
}

export function oauthClient(): OAuth2Client {
  const c = config();
  return new OAuth2Client({
    clientId: c.GOOGLE_CLIENT_ID,
    clientSecret: c.GOOGLE_CLIENT_SECRET,
    redirectUri: redirectUri(),
  });
}

export function authUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SERVER_SCOPES,
    hd: config().ALLOWED_DOMAIN,
    include_granted_scopes: true,
    state,
  });
}

export interface VerifiedLogin {
  email: string;
  name: string | null;
  sub: string;
  refreshToken: string | null;
}

export async function exchangeCode(code: string): Promise<VerifiedLogin> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error("Google から ID トークンが返りませんでした");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config().GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) throw new Error("メールアドレスを確認できませんでした");
  if (payload.hd !== config().ALLOWED_DOMAIN) {
    throw new Error(`${config().ALLOWED_DOMAIN} のアカウントでログインしてください`);
  }
  return {
    email: payload.email.toLowerCase(),
    name: payload.name ?? null,
    sub: payload.sub,
    refreshToken: tokens.refresh_token ?? null,
  };
}

export function clientForRefreshToken(refreshTokenEnc: string): OAuth2Client {
  const client = oauthClient();
  client.setCredentials({ refresh_token: decryptSecret(refreshTokenEnc) });
  return client;
}

/** Pub/Sub の push リクエストに付く OIDC トークンを検証する */
export async function verifyPubSubToken(authorization: string | null): Promise<boolean> {
  const c = config();
  if (!c.PUBSUB_PUSH_SERVICE_ACCOUNT) return false;
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return false;
  try {
    const ticket = await new OAuth2Client().verifyIdToken({
      idToken: token,
      audience: `${c.APP_BASE_URL}/api/gmail/push`,
    });
    const payload = ticket.getPayload();
    return payload?.email === c.PUBSUB_PUSH_SERVICE_ACCOUNT && payload.email_verified === true;
  } catch {
    return false;
  }
}
