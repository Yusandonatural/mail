"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendToFreeeAction } from "@/app/actions/freee";

export interface FreeeAttachment {
  partId: string;
  filename: string;
  receiptId: string | null;
}

export function FreeePanel({ rowId, attachments, companyName }: { rowId: number; attachments: FreeeAttachment[]; companyName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="panel stack">
      <h2>
        freee
        <span className="meta">{companyName}</span>
      </h2>
      <p className="meta">請求書・領収書をファイルボックスに送ります。仕訳は freee の画面で行ってください。</p>
      {attachments.map((a) => (
        <div key={a.partId} className="actions" style={{ justifyContent: "space-between" }}>
          <span>{a.filename}</span>
          {a.receiptId ? (
            <span className="badge draft">送信済み（証憑 {a.receiptId}）</span>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setMessage(null);
                  const r = await sendToFreeeAction(rowId, a.partId);
                  setMessage(r.ok ? (r.data?.already ? "既に送信済みでした" : "freee に送りました") : r.error);
                  router.refresh();
                })
              }
            >
              ファイルボックスに送る
            </button>
          )}
        </div>
      ))}
      {pending ? <div className="meta">送信中…</div> : null}
      {message ? <div className="meta">{message}</div> : null}
    </div>
  );
}
