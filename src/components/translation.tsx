"use client";

import { useCallback, useEffect, useState } from "react";
import { translateMessageAction } from "@/app/actions/translate";

/** 外国語のメールの下に、日本語訳を出す（開いたときに訳す） */
export function Translation({ rowId, gmailMessageId }: { rowId: number; gmailMessageId: string }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "done"; subject: string; body: string } | { kind: "none" } | { kind: "error"; message: string }
  >({ kind: "loading" });

  const load = useCallback(() => {
    setState({ kind: "loading" });
    translateMessageAction(rowId, gmailMessageId)
      .then((r) => {
        if (!r.ok) setState({ kind: "error", message: r.error });
        else if (!r.data) setState({ kind: "none" });
        else setState({ kind: "done", ...r.data });
      })
      .catch(() => setState({ kind: "error", message: "翻訳できませんでした" }));
  }, [rowId, gmailMessageId]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.kind === "none") return null;
  return (
    <div className="translation" lang="ja">
      <div className="translation-head">
        <span>日本語訳</span>
        <span className="meta">Claude による翻訳。原文と食い違うときは原文が正です</span>
      </div>
      {state.kind === "loading" ? <p className="meta">翻訳中…</p> : null}
      {state.kind === "error" ? (
        <p className="placeholder-list">
          {state.message}{" "}
          <button type="button" onClick={load}>
            もう一度訳す
          </button>
        </p>
      ) : null}
      {state.kind === "done" ? (
        <>
          {state.subject ? <p className="translation-subject">件名：{state.subject}</p> : null}
          <pre>{state.body}</pre>
        </>
      ) : null}
    </div>
  );
}
