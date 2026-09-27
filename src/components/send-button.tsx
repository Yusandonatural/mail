"use client";

/**
 * 送信ボタン。メールの送信はここ（ブラウザ）だけで行う。
 * Google Identity Services で本人から gmail.compose の一時トークンをもらい、Gmail API の drafts.send を直接呼ぶ。
 * サーバーは送信の API を一切呼ばない（仕様書 5章・11章）。
 */

import { useState } from "react";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface GisTokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            hint?: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string }) => void;
          }): GisTokenClient;
        };
      };
    };
  }
}

const SCOPE = "https://www.googleapis.com/auth/gmail.compose";
let cached: { token: string; expiresAt: number; email: string } | null = null;
let gisLoading: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google のログイン部品を読み込めませんでした"));
    document.head.appendChild(s);
  });
  return gisLoading;
}

async function accessToken(clientId: string, email: string): Promise<string> {
  if (cached && cached.email === email && cached.expiresAt > Date.now() + 60_000) return cached.token;
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      hint: email,
      callback: (r) => {
        if (!r.access_token) return reject(new Error(r.error ?? "送信の許可が得られませんでした"));
        cached = { token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3000) * 1000, email };
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "許可の画面が閉じられました" : e.type)),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

export async function sendDraftFromBrowser(clientId: string, email: string, draftId: string): Promise<void> {
  const token = await accessToken(clientId, email);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: draftId }),
  });
  if (!res.ok) {
    if (res.status === 401) cached = null;
    const detail = await res.text().catch(() => "");
    throw new Error(`送信に失敗しました（${res.status}）${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
}

type Prepared = { ok: true; data?: { gmailDraftId: string; email: string } } | { ok: false; error: string };

export function SendButton({
  clientId,
  disabled,
  prepare,
  after,
  label = "送信",
}: {
  clientId: string;
  disabled?: boolean;
  prepare: () => Promise<Prepared>;
  after: (sent: { gmailDraftId: string; email: string }) => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="actions">
      <button
        type="button"
        className="primary"
        disabled={disabled || busy}
        onClick={async () => {
          if (!window.confirm("このメールを送信します。よろしいですか？")) return;
          setBusy(true);
          setError(null);
          try {
            const r = await prepare();
            if (!r.ok) throw new Error(r.error);
            if (!r.data) throw new Error("下書きが見つかりません");
            await sendDraftFromBrowser(clientId, r.data.email, r.data.gmailDraftId);
            await after(r.data);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "送信中…" : label}
      </button>
      {error ? <span className="placeholder-list">{error}</span> : null}
    </span>
  );
}
