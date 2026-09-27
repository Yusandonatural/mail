"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { findPlaceholders } from "@/lib/placeholders";
import { emptyReplyAction, generateDraftAction, markSentAction, prepareSendAction, saveDraftAction } from "@/app/actions/mail";
import { SendButton } from "./send-button";

const PRESETS = ["もっと短く", "もっと丁寧に", "英語で", "日本語で"];

export interface DraftView {
  id: number;
  gmailDraftId: string;
  gmailMessageId: string;
  text: string;
  notes: string;
  version: number;
  instruction: string | null;
}

export function DraftEditor({
  draft,
  rowId,
  clientId,
  userEmail,
  label,
  backHref,
}: {
  draft: DraftView;
  rowId: number;
  clientId: string;
  userEmail: string;
  label: string;
  backHref: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(draft.text);
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const placeholders = useMemo(() => findPlaceholders(text), [text]);
  const dirty = text !== draft.text;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okMessage: string) =>
    start(async () => {
      setStatus(null);
      const r = await fn();
      setStatus(r.ok ? okMessage : (r.error ?? "失敗しました"));
      if (r.ok) router.refresh();
    });

  return (
    <div className="panel stack">
      <h2>
        {label}
        <span className="meta">
          v{draft.version}
          {draft.instruction ? `・指示「${draft.instruction}」` : ""}
        </span>
      </h2>
      {draft.notes ? <div className="notes">{draft.notes}</div> : null}
      <textarea data-draft rows={16} value={text} onChange={(e) => setText(e.target.value)} />
      {placeholders.length ? (
        <div className="placeholder-list">
          埋めてほしい箇所（{placeholders.length}）：{placeholders.map((p) => p.label || "（無題）").join("、")}
        </div>
      ) : (
        <div className="meta">【要確認】は全て埋まっています</div>
      )}
      <div className="actions">
        <SendButton
          clientId={clientId}
          disabled={placeholders.length > 0 || pending}
          prepare={() => prepareSendAction(draft.id, text)}
          after={async () => {
            await markSentAction(draft.id);
            router.push(backHref);
            router.refresh();
          }}
        />
        <button type="button" disabled={!dirty || pending} onClick={() => run(() => saveDraftAction(draft.id, text), "保存しました")}>
          保存
        </button>
        <a
          className="button"
          target="_blank"
          rel="noreferrer"
          href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(userEmail)}#drafts?compose=${draft.gmailMessageId}`}
        >
          Gmail で開く
        </a>
      </div>
      <details>
        <summary>書き直す（Claude）</summary>
        <div className="stack">
          <div className="actions">
            {PRESETS.map((p) => (
              <button key={p} type="button" disabled={pending} onClick={() => run(() => generateDraftAction(rowId, p), "書き直しました")}>
                {p}
              </button>
            ))}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => generateDraftAction(rowId, "カレンダーの空き時間から日程の候補を3つ示す形にしてください", true),
                  "空き時間の候補を入れました",
                )
              }
            >
              候補を3つ提案
            </button>
          </div>
          <div className="inline-form">
            <div>
              <input
                value={instruction}
                placeholder="自由に指示（例：来週は不在と伝えて）"
                onChange={(e) => setInstruction(e.target.value)}
              />
            </div>
            <button
              type="button"
              disabled={pending || !instruction.trim()}
              onClick={() => run(() => generateDraftAction(rowId, instruction), "書き直しました")}
            >
              書き直す
            </button>
          </div>
          {dirty ? <div className="meta">手で直した内容は上書きされず、別案として新しい下書きができます。</div> : null}
        </div>
      </details>
      {pending ? <div className="meta">処理中…（Claude の下書きは数十秒かかることがあります）</div> : null}
      {status ? <div className="meta">{status}</div> : null}
    </div>
  );
}

export function DraftCreate({ rowId }: { rowId: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) router.refresh();
      else setError(r.error ?? "失敗しました");
    });
  return (
    <div className="panel stack">
      <h2>返信</h2>
      <div className="actions">
        <button type="button" className="primary" disabled={pending} onClick={() => go(() => generateDraftAction(rowId, null))}>
          下書きを作る（Claude）
        </button>
        <button type="button" disabled={pending} onClick={() => go(() => generateDraftAction(rowId, null, true))}>
          空き時間の候補つきで作る
        </button>
        <button type="button" disabled={pending} onClick={() => go(() => emptyReplyAction(rowId))}>
          手で書く
        </button>
      </div>
      {pending ? <div className="meta">作成中…</div> : null}
      {error ? <div className="placeholder-list">{error}</div> : null}
    </div>
  );
}
