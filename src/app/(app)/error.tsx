"use client";

import Link from "next/link";

/** 画面の処理で失敗したとき（Gmail・カレンダーの一時的なエラーなど）に、何が起きたかを見せる */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="panel stack" style={{ maxWidth: 640 }}>
      <h1>処理できませんでした</h1>
      <p>
        Gmail や Google カレンダーとのやりとりで失敗したか、画面の処理でエラーが起きました。もう一度試しても直らないときは、下の番号を添えて知らせてください。
      </p>
      <p className="meta">
        {error.message && !error.message.startsWith("An error occurred in the Server Components render") ? error.message : "詳しい内容はサーバーの記録にあります"}
        {error.digest ? `（番号: ${error.digest}）` : ""}
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={() => reset()}>
          もう一度試す
        </button>
        <Link className="button" href="/inbox">
          受信箱へ
        </Link>
      </div>
    </div>
  );
}
