"use client";

import { useSearchParams } from "next/navigation";

/**
 * 操作の結果（「送信しました」「3件を迷惑メールにしました」など）を画面の上に出す帯。
 * URL の ?notice= に入れて渡す。送信のときは ?sent=<スレッド> で Gmail の確認リンクも出す。
 */
export function NoticeBanner({ userEmail }: { userEmail: string }) {
  const sp = useSearchParams();
  const notice = sp.get("notice");
  if (!notice) return null;
  const sent = sp.get("sent");
  const safeSent = sent && /^[0-9a-f]{1,32}$/i.test(sent) ? sent : null;
  return (
    <div className={sent ? "banner sent" : "banner confirm"} role="status">
      {sent ? <span className="sent-mark" aria-hidden="true">✓</span> : null}
      <span>{notice.slice(0, 300)}</span>
      {safeSent ? (
        <a
          href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(userEmail)}#all/${safeSent}`}
          target="_blank"
          rel="noreferrer"
        >
          Gmail で送ったメールを見る
        </a>
      ) : null}
    </div>
  );
}
