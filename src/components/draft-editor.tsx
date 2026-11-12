"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { findPlaceholders, type Placeholder } from "@/lib/placeholders";
import { translateReplyAction } from "@/app/actions/translate";
import { LANGUAGE_LABELS, LANGUAGES } from "@/lib/domain";
import { emptyReplyAction, generateDraftAction, markSentAction, prepareSendAction, saveDraftAction } from "@/app/actions/mail";
import { SendButton, withSentNotice } from "./send-button";

const PRESETS = ["もっと短く", "もっと丁寧に", "英語で", "日本語で"];

/** Claude のメモから「確認した情報: …」の行を分けて、調べた先を一つずつ見せる */
function splitNotes(notes: string): { body: string; sources: string[] } {
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  const sources: string[] = [];
  const rest: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*確認した情報\s*[:：]\s*(.*)$/);
    if (m) sources.push(...m[1].split(/[、,]\s*/).map((s) => s.trim()).filter(Boolean));
    else rest.push(line);
  }
  return { body: rest.join("\n").trim(), sources };
}

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
  // サーバーの本文（保存・書き直し・Gmail での編集で変わる）。手で直していなければ新しい本文に入れ替える。
  // 作り直さず（key を変えず）に入れ替えるので、「保存しました」「書き直しました」の知らせが消えない
  const [base, setBase] = useState(draft.text);
  if (draft.text !== base) {
    setBase(draft.text);
    // 保存した本文は Gmail 側で前後の空白が詰められて戻るので、それも同じ本文とみなす
    if (text === base || text.replace(/\r\n/g, "\n").trim() === draft.text) setText(draft.text);
  }
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const placeholders = useMemo(() => findPlaceholders(text), [text]);
  const notes = useMemo(() => splitNotes(draft.notes), [draft.notes]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== draft.text;

  /** 本文の【要確認】を選んだ状態にする（そのまま打てば置き換わる） */
  const select = (p: Placeholder) => {
    const ta = textRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    // 選んだ場所がテキスト欄の中ほどに来るよう、手前までの高さを測ってスクロールする
    const full = ta.value;
    ta.value = full.slice(0, p.index);
    const height = ta.scrollHeight;
    ta.value = full;
    ta.scrollTop = Math.max(0, height - ta.clientHeight / 2);
    ta.setSelectionRange(p.index, p.index + p.raw.length);
    ta.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  /** カーソルの後ろにある次の【要確認】（最後まで行ったら最初に戻る） */
  const selectNext = () => {
    const at = textRef.current?.selectionEnd ?? 0;
    const next = placeholders.find((p) => p.index >= at) ?? placeholders[0];
    if (next) select(next);
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okMessage: string) =>
    start(async () => {
      setStatus(null);
      const r = await fn();
      setStatus(r.ok ? { text: okMessage } : { text: r.error ?? "失敗しました", error: true });
      if (r.ok) router.refresh();
    });

  /**
   * Claude で書き直す。手で直した本文がまだ保存されていなければ先に Gmail に保存する
   * （保存しておけば、サーバーは人が直した下書きとして残し、書き直しを別案として作る。保存しないと上書きで消える）
   */
  const rewrite = async (instr: string, withSlots = false) => {
    if (dirty) {
      const saved = await saveDraftAction(draft.id, text);
      if (!saved.ok) return saved;
    }
    return generateDraftAction(rowId, instr, withSlots);
  };

  return (
    <section className="panel stack" aria-labelledby={`draft-${draft.id}`}>
      <h2 className="draft-head">
        <span id={`draft-${draft.id}`}>{label}</span>
        <span className="meta">
          {draft.version > 1 ? `第${draft.version}版` : ""}
          {draft.instruction ? `・指示「${draft.instruction}」` : ""}
        </span>
      </h2>
      {notes.body || notes.sources.length ? (
        <div className="draft-notes">
          {notes.body ? <p className="draft-notes-text">{notes.body}</p> : null}
          {notes.sources.length ? (
            <div className="draft-sources">
              <span className="draft-sources-label">確認した情報</span>
              <ul>
                {notes.sources.map((src, i) => (
                  <li key={i}>{src}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {placeholders.length ? (
        <div className="ph-box" role="group" aria-labelledby={`ph-${draft.id}`}>
          <div className="ph-head">
            <strong id={`ph-${draft.id}`}>【要確認】あと{placeholders.length}か所</strong>
            <span className="meta">押すと本文のその場所を選びます</span>
          </div>
          <ol className="ph-list">
            {placeholders.map((p, i) => (
              <li key={`${p.index}-${i}`}>
                <button type="button" className="ph-item" onClick={() => select(p)}>
                  <span className="ph-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="ph-label">{p.label || "（説明なし）"}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <textarea
        ref={textRef}
        data-draft
        className={placeholders.length ? "draft-text has-ph" : "draft-text"}
        aria-labelledby={`draft-${draft.id}`}
        rows={16}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
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
        {placeholders.length ? (
          <button type="button" className="ph-next" onClick={selectNext}>
            【要確認】へ<span className="ph-count">{placeholders.length}</span>
          </button>
        ) : (
          <span className="check-ok">✓ 埋める箇所なし</span>
        )}
        <span className="spacer" />
        <button type="button" disabled={!dirty || pending} onClick={() => run(() => saveDraftAction(draft.id, text), "保存しました")}>
          {dirty ? "保存" : "保存済み"}
        </button>
      </div>
      <div role="status" aria-live="polite" className="draft-status">
        {pending ? (
          <div className="status busy">処理中…（Claude は数十秒かかることがあります）</div>
        ) : status ? (
          <div className={status.error ? "status error" : "status done"}>{status.text}</div>
        ) : null}
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
        <summary>Claude で書き直す</summary>
        <div className="stack">
          <div className="actions">
            {PRESETS.map((p) => (
              <button key={p} type="button" disabled={pending} onClick={() => run(() => rewrite(p), "書き直しました")}>
                {p}
              </button>
            ))}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => rewrite("カレンダーの空き時間から日程の候補を3つ示す形にしてください", true),
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
                    run(() => rewrite(instruction), "書き直しました");
                  }
                }}
              />
            </div>
            <button
              type="button"
              disabled={pending || !instruction.trim()}
              onClick={() => run(() => rewrite(instruction), "書き直しました")}
            >
              書き直す
            </button>
          </div>
          {dirty ? <div className="meta">手で直した本文は消えません。書き直しは別案として増えます。</div> : null}
        </div>
      </details>
      <p className="meta draft-foot">
        <a
          target="_blank"
          rel="noreferrer"
          href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(userEmail)}#drafts?compose=${draft.gmailMessageId}`}
        >
          Gmail で開く
        </a>
        （添付を足すときなど）
      </p>
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
