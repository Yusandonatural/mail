"use client";

import { useEffect, useRef } from "react";

/**
 * HTML メールの表示。スクリプトは動かさない（sandbox に allow-scripts を付けない）。
 * 外部画像は追跡に使われるので既定では読み込まない。リンクは新しいタブで開く。
 */
export function HtmlFrame({ html, showImages }: { html: string; showImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${showImages ? "https: http:" : ""}; font-src data:`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic UI","Segoe UI",system-ui,sans-serif;font-size:14.5px;line-height:1.65;margin:14px 16px;color:#1b1f27;background:#fff;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#2f6fed}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d5d9e0;color:#555}</style></head><body>${html}</body></html>`;
  const fit = () => {
    const f = ref.current;
    // html 要素の offsetHeight は中身の高さ（枠の高さに引きずられないので、縮むときも合う）
    const h = f?.contentDocument?.documentElement?.offsetHeight;
    if (f && h) f.style.height = `${Math.min(h + 4, 4000)}px`;
  };
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    // サーバーで描いた iframe は、画面が動き出す前に読み込みを終えていることがあるので、ここでも測る
    let observer: ResizeObserver | undefined;
    const watch = () => {
      fit();
      const body = f.contentDocument?.body;
      if (!body || typeof ResizeObserver === "undefined") return;
      observer?.disconnect();
      // 画像の読み込みや画面幅の変化で本文の高さが変わったら合わせ直す
      observer = new ResizeObserver(() => fit());
      observer.observe(body);
    };
    if (f.contentDocument?.readyState === "complete") watch();
    f.addEventListener("load", watch);
    // 閉じた古いメールは表示されていないので高さを測れない。開いたときに測り直す
    const details = f.closest("details");
    details?.addEventListener("toggle", fit);
    return () => {
      observer?.disconnect();
      f.removeEventListener("load", watch);
      details?.removeEventListener("toggle", fit);
    };
  }, [doc]);
  return (
    <iframe
      ref={ref}
      className="mail-frame"
      title="メール本文"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
    />
  );
}
