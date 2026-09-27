"use client";

import { useEffect, useState } from "react";
import { deletePushSubscription, savePushSubscription } from "@/app/actions/push";

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function b64(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type State = "unsupported" | "ios-install" | "off" | "on" | "denied" | "busy";

/** 通知の受け取りを端末ごとに ON/OFF する。iPhone はホーム画面に追加したときだけ使える */
export function NotifyToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<State>("busy");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ios = /iPhone|iPad/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState(ios && !standalone ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function turnOn() {
    setState("busy");
    setError(null);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setState(perm === "denied" ? "denied" : "off");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
      await savePushSubscription({
        endpoint: sub.endpoint,
        p256dh: b64(sub.getKey("p256dh")),
        auth: b64(sub.getKey("auth")),
        userAgent: navigator.userAgent,
      });
      setState("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("off");
    }
  }

  async function turnOff() {
    setState("busy");
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await deletePushSubscription(sub.endpoint);
      await sub.unsubscribe();
    }
    setState("off");
  }

  if (state === "unsupported") return null;
  return (
    <div className="notify-toggle">
      {state === "ios-install" ? (
        <span className="meta">通知を受け取るには、共有メニューから「ホーム画面に追加」してください</span>
      ) : state === "denied" ? (
        <span className="meta">通知がブラウザでブロックされています</span>
      ) : state === "on" ? (
        <button type="button" onClick={turnOff}>
          🔔 通知 ON（この端末）
        </button>
      ) : (
        <button type="button" disabled={state === "busy"} onClick={turnOn}>
          🔕 通知を受け取る
        </button>
      )}
      {error ? <div className="placeholder-list">{error}</div> : null}
    </div>
  );
}
