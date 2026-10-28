"use client";

/**
 * 送信ボタン。メールの送信はここ（ブラウザ）だけで行う。
 * Google Identity Services で本人から gmail.compose の一時トークンをもらい、Gmail API の drafts.send を直接呼ぶ。
 * サーバーは送信の API を一切呼ばない（仕様書 5章・11章）。
 */

import { useEffect, useState } from "react";

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
    s.onerror = () => {
      gisLoading = null;
      reject(new Error("Google のログイン部品を読み込めませんでした"));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

/**
 * 送信の許可（一時トークン）をもらう。ポップアップがブロックされないよう、
 * クリックの処理の中で「待たずに」呼ぶこと（部品は画面を開いたときに読み込んでおく）。
 */
function requestToken(clientId: string, email: string): Promise<string> {
  if (cached && cached.email === email && cached.expiresAt > Date.now() + 60_000) return Promise.resolve(cached.token);
  const ask = () =>
    new Promise<string>((resolve, reject) => {
      const client = window.google!.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        hint: email,
        callback: (r) => {
          if (!r.access_token) return reject(new Error(r.error ?? "送信の許可が得られませんでした"));
          cached = { token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3000) * 1000, email };
          resolve(r.access_token);
        },
        error_callback: (e) =>
          reject(new Error(e.type === "popup_closed" ? "許可の画面が閉じられました" : `許可の画面を開けませんでした（${e.type}）`)),
      });
      client.requestAccessToken({ prompt: "" });
    });
  if (window.google?.accounts?.oauth2) return ask();
  return loadGis().then(ask);
}

export interface SentMessage {
  gmailDraftId: string;
  email: string;
  /** Gmail が返した、送ったメールの ID とスレッド */
  messageId: string;
  threadId: string;
}

async function sendDraft(token: string, draftId: string): Promise<{ id: string; threadId: string }> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: draftId }),
  });
  if (!res.ok) {
    if (res.status === 401) cached = null;
    const detail = await res.text().catch(() => "");
    throw new Error(`送信できませんでした（${res.status}）${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
  return { id: body.id ?? "", threadId: body.threadId ?? "" };
}

/** 送信後に開く一覧の URL に「送信しました」の知らせを付ける（画面上部の帯に出る） */
export function withSentNotice(href: string, text: string, threadId: string): string {
  const url = new URL(href, "http://x");
  url.searchParams.set("notice", text);
  if (threadId) url.searchParams.set("sent", threadId);
  return `${url.pathname}${url.search}`;
}

type Prepared = { ok: true; data?: { gmailDraftId: string; email: string } } | { ok: false; error: string };

export function SendButton({
  clientId,
  email,
  disabled,
  prepare,
  after,
  label = "送信",
}: {
  clientId: string;
  email: string;
  disabled?: boolean;
  prepare: () => Promise<Prepared>;
  after: (sent: SentMessage) => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    loadGis().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(t);
  }, [confirming]);

  function onClick() {
    if (!confirming) {
      setConfirming(true);
      setError(null);
      return;
    }
    setConfirming(false);
    setBusy(true);
    // 許可の画面はここで、待たずに開く
    const token = requestToken(clientId, email);
    (async () => {
      try {
        const r = await prepare();
        if (!r.ok) throw new Error(r.error);
        if (!r.data) throw new Error("下書きが見つかりません");
        const msg = await sendDraft(await token, r.data.gmailDraftId);
        // ここまで来れば相手に届いている。後の記録で失敗しても「送れていない」とは言わない
        setSent(true);
        try {
          await after({ ...r.data, messageId: msg.id, threadId: msg.threadId });
        } catch (e) {
          setError(`送信はできました。アプリへの記録だけ失敗しました（${e instanceof Error ? e.message : String(e)}）。もう一度送らないでください`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
    token.catch(() => undefined);
  }

  return (
    <span className="actions">
      {sent ? (
        <span className="sent-ok" role="status">
          ✓ 送信しました
        </span>
      ) : (
        <button type="button" className="primary" disabled={disabled || busy} onClick={onClick}>
          {busy ? "送信中…" : confirming ? "もう一度押すと送信します" : label}
        </button>
      )}
      {confirming && !sent ? (
        <button type="button" onClick={() => setConfirming(false)}>
          やめる
        </button>
      ) : null}
      {error ? <span className="placeholder-list">{error}</span> : null}
    </span>
  );
}
