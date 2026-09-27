"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { findPlaceholders } from "@/lib/placeholders";
import { createComposeDraft, recordComposeSent } from "@/app/actions/compose";
import { SendButton } from "./send-button";

export interface ComposeDefaults {
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  forwardRowId: number | null;
  attachmentNames: string[];
}

export function ComposeForm({
  defaults,
  fromOptions,
  clientId,
}: {
  defaults: ComposeDefaults;
  fromOptions: Array<{ email: string; name: string | null }>;
  clientId: string;
}) {
  const router = useRouter();
  const [v, setV] = useState(defaults);
  const [includeAttachments, setInclude] = useState(true);
  const placeholders = useMemo(() => findPlaceholders(v.text), [v.text]);
  const set = (k: keyof ComposeDefaults) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV({ ...v, [k]: e.target.value });

  return (
    <div className="panel stack">
      <div>
        <label>送信元</label>
        <select value={v.from} onChange={set("from")}>
          {fromOptions.map((o) => (
            <option key={o.email} value={o.email}>
              {o.name ? `${o.name} <${o.email}>` : o.email}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>宛先（カンマ区切り）</label>
        <input value={v.to} onChange={set("to")} />
      </div>
      <div>
        <label>Cc</label>
        <input value={v.cc} onChange={set("cc")} />
      </div>
      <div>
        <label>件名</label>
        <input value={v.subject} onChange={set("subject")} />
      </div>
      <div>
        <label>本文</label>
        <textarea rows={16} value={v.text} onChange={set("text")} />
      </div>
      {v.attachmentNames.length ? (
        <label className="inline">
          <input type="checkbox" checked={includeAttachments} onChange={(e) => setInclude(e.target.checked)} />
          元の添付ファイルを付ける（{v.attachmentNames.join("、")}）
        </label>
      ) : null}
      {placeholders.length ? <div className="placeholder-list">【要確認】が残っています</div> : null}
      <div className="actions">
        <SendButton
          clientId={clientId}
          disabled={placeholders.length > 0 || !v.to.trim()}
          prepare={() =>
            createComposeDraft({
              from: v.from,
              to: v.to,
              cc: v.cc,
              subject: v.subject,
              text: v.text,
              forwardRowId: v.forwardRowId,
              includeAttachments,
            })
          }
          after={async (sent) => {
            await recordComposeSent(sent.gmailDraftId, v.subject);
            router.push("/inbox");
          }}
        />
        <button
          type="button"
          onClick={async () => {
            const r = await createComposeDraft({
              from: v.from,
              to: v.to,
              cc: v.cc,
              subject: v.subject,
              text: v.text,
              forwardRowId: v.forwardRowId,
              includeAttachments,
              saveOnly: true,
            });
            alert(r.ok ? "Gmail の下書きに保存しました" : r.error);
          }}
        >
          下書きに保存
        </button>
      </div>
    </div>
  );
}
