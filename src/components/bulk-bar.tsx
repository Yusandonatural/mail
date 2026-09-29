"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * 一覧の上の操作帯。チェックした件数を数え、「全て選択」と
 * 迷惑メール／ゴミ箱／アーカイブのボタンを出す（送信先は一覧を囲む form）。
 */
export function BulkBar() {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);
  const { pending } = useFormStatus();

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const boxes = () => Array.from(form.querySelectorAll<HTMLInputElement>('input[name="sel"]'));
    const update = () => {
      const all = boxes();
      setTotal(all.length);
      setCount(all.filter((b) => b.checked).length);
    };
    update();
    form.addEventListener("change", update);
    return () => form.removeEventListener("change", update);
  }, []);

  function toggleAll(on: boolean) {
    const form = ref.current?.closest("form");
    if (!form) return;
    form.querySelectorAll<HTMLInputElement>('input[name="sel"]').forEach((b) => (b.checked = on));
    form.dispatchEvent(new Event("change"));
  }

  return (
    <div ref={ref} className={count ? "bulkbar active" : "bulkbar"}>
      <label className="pick" title="全て選択">
        <input
          type="checkbox"
          aria-label="このページのメールを全て選択"
          checked={total > 0 && count === total}
          ref={(el) => {
            if (el) el.indeterminate = count > 0 && count < total;
          }}
          onChange={(e) => toggleAll(e.target.checked)}
        />
      </label>
      {count ? (
        <>
          <span className="meta">{pending ? "処理中…" : `${count}件を選択中`}</span>
          <button type="submit" name="kind" value="spam" className="danger" disabled={pending}>
            迷惑メールにする
          </button>
          <button type="submit" name="kind" value="trash" className="danger" disabled={pending}>
            ゴミ箱へ
          </button>
          <button type="submit" name="kind" value="archive" disabled={pending}>
            アーカイブ
          </button>
          <label className="meta block-opt">
            <input type="checkbox" name="block" value="1" /> 迷惑メールにした送信者は、今後も自動で迷惑メールへ
          </label>
        </>
      ) : (
        <span className="meta">チェックしてまとめて迷惑メール・削除できます（行の右端の「迷惑」「削除」でも1通ずつ）</span>
      )}
    </div>
  );
}
