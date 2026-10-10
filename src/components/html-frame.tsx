"use client";

import { useEffect, useRef } from "react";

/**
 * HTML メールの表示。スクリプトは動かさない（sandbox に allow-scripts を付けない）。
 * 外部画像は追跡に使われるので既定では読み込まない。リンクは新しいタブで開く。
 */
export function HtmlFrame({ html, showImages }: { html: string; showImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${showImages ? "https: http:" : ""}; font-src data:`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{font-family:system-ui,sans-serif;font-size:14px;margin:8px;color:#222;background:#fff;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  const fit = () => {
    const f = ref.current;
    const h = f?.contentDocument?.documentElement?.scrollHeight;
    if (f && h) f.style.height = `${Math.min(h + 24, 4000)}px`;
  };
  // 閉じた古いメールは表示されていないので高さを測れない。開いたときに測り直す
  useEffect(() => {
    const details = ref.current?.closest("details");
    if (!details) return;
    details.addEventListener("toggle", fit);
    return () => details.removeEventListener("toggle", fit);
  }, []);
  return (
    <iframe
      ref={ref}
      className="mail-frame"
      title="メール本文"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      onLoad={fit}
    />
  );
}
