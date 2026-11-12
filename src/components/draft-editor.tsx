"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { findPlaceholders } from "@/lib/placeholders";
import { translateReplyAction } from "@/app/actions/translate";
import { LANGUAGE_LABELS, LANGUAGES } from "@/lib/domain";
import { emptyReplyAction, generateDraftAction, markSentAction, prepareSendAction, saveDraftAction } from "@/app/actions/mail";
import { SendButton, withSentNotice } from "./send-button";

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
  replyLanguage,
}: {
  draft: DraftView;
  rowId: number;
  clientId: string;
  userEmail: string;
  label: string;
  backHref: string;
  replyLanguage: string;
}) {
  const [target, setTarget] = useState(replyLanguage);
  const [beforeTranslate, setBeforeTranslate] = useState<string | null>(null);
  const router = useRouter();
  const [text, setText] = useState(draft.text);
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const placeholders = useMemo(() => findPlaceholders(text), [text]);
  const dirty = text !== draft.text;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okMessage: string) =>
    start(async () => {
      setStatus(null);
      const r = await fn();
      setStatus(r.ok ? { text: okMessage } : { text: r.error ?? "失敗しました", error: true });
      if (r.ok) router.refresh();
    });

  return (
    <section className="panel stack" aria-labelledby={`draft-${draft.id}`}>
      <h2 className="draft-head">
        <span id={`draft-${draft.id}`}>{label}</span>
        <span className="meta">
          {draft.version > 1 ? `第${draft.version}版` : ""}
          {draft.instruction ? `・指示「${draft.instruction}」` : ""}
        </span>
      </h2>
      {draft.notes ? <div className="notes">{draft.notes}</div> : null}
      <textarea
        data-draft
        className="draft-text"
        aria-labelledby={`draft-${draft.id}`}
        rows={16}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {placeholders.length ? (
        <div className="placeholder-list">
          【要確認】が{placeholders.length}か所あります（{placeholders.map((p) => p.label || "無題").join("、")}）。埋めると送信できます
        </div>
      ) : (
        <div className="check-ok">✓ 【要確認】はありません</div>
      )}
      <div className="send-row">
        <SendButton
          clientId={clientId}
          email={userEmail}
          disabled={placeholders.length > 0 || pending}
          prepare={() => prepareSendAction(draft.id, text)}
          after={async (sent) => {
            const r = await markSentAction(draft.id);
            if (!r.ok) throw new Error(r.error);
            router.push(withSentNotice(backHref, "返信を送信しました", sent.threadId));
            router.refresh();
          }}
        />
        <span className="spacer" />
        <button type="button" disabled={!dirty || pending} onClick={() => run(() => saveDraftAction(draft.id, text), "保存しました")}>
          {dirty ? "保存" : "保存済み"}
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
      <details className="tool" open={beforeTranslate !== null}>
        <summary>翻訳する</summary>
        <div className="stack">
          <p className="meta">日本語で書いた返信を訳して、上の本文と置き換えます。署名も訳した言語のものにします。保存・送信はまだしません。</p>
          <div className="inline-form">
            <div>
              <label htmlFor={`target-${draft.id}`}>翻訳先</label>
              <select id={`target-${draft.id}`} value={target} onChange={(e) => setTarget(e.target.value)}>
                {LANGUAGES.filter((l) => l !== "ja").map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={pending || !text.trim()}
              onClick={() =>
                start(async () => {
                  setStatus(null);
                  const original = text;
                  const r = await translateReplyAction(draft.id, original, target);
                  if (!r.ok || !r.data) {
                    setStatus({ text: r.ok ? "翻訳できませんでした" : r.error, error: true });
                    return;
                  }
                  setBeforeTranslate(original);
                  setText(r.data.text);
                  setStatus({ text: `${LANGUAGE_LABELS[target as keyof typeof LANGUAGE_LABELS]}に訳しました。内容を確かめてから保存・送信してください` });
                })
              }
            >
              翻訳する
            </button>
          </div>
          {beforeTranslate !== null ? (
            <div className="translation" lang="ja">
              <div className="translation-head">
                <span>元の日本語</span>
                <button
                  type="button"
                  onClick={() => {
                    setText(beforeTranslate);
                    setBeforeTranslate(null);
                    setStatus({ text: "元の日本語に戻しました" });
                  }}
                >
                  元に戻す
                </button>
              </div>
              <pre>{beforeTranslate}</pre>
            </div>
          ) : null}
        </div>
      </details>
      <details className="tool">
        <summary>Claude に書き直してもらう</summary>
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
              <label htmlFor={`instruction-${draft.id}`} className="visually-hidden">
                書き直しの指示
              </label>
              <input
                id={`instruction-${draft.id}`}
                value={instruction}
                placeholder="指示を書く（例：来週は不在と伝えて）"
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && instruction.trim() && !pending) {
                    e.preventDefault();
                    run(() => generateDraftAction(rowId, instruction), "書き直しました");
                  }
                }}
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
          {dirty ? <div className="meta">手で直した本文は消えません。書き直しは別案として増えます。</div> : null}
        </div>
      </details>
      <div role="status" aria-live="polite">
        {pending ? <div className="status busy">処理中…（Claude は数十秒かかることがあります）</div> : status ? <div className={status.error ? "placeholder-list" : "status"}>{status.text}</div> : null}
      </div>
    </section>
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
      <p className="meta">まだ下書きがありません。</p>
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
      <div role="status" aria-live="polite">
        {pending ? <div className="status busy">作成中…（数十秒かかることがあります）</div> : null}
        {error ? <div className="placeholder-list">{error}</div> : null}
      </div>
    </div>
  );
}
