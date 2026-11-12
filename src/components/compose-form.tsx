"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { findPlaceholders } from "@/lib/placeholders";
import { createComposeDraft, recordComposeSent } from "@/app/actions/compose";
import { SendButton, withSentNotice } from "./send-button";

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
  userEmail,
}: {
  defaults: ComposeDefaults;
  fromOptions: Array<{ email: string; name: string | null }>;
  clientId: string;
  userEmail: string;
}) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const router = useRouter();
  const [v, setV] = useState(defaults);
  const [includeAttachments, setInclude] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const placeholders = useMemo(() => findPlaceholders(v.text), [v.text]);
  const set = (k: keyof ComposeDefaults) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV({ ...v, [k]: e.target.value });

  return (
    <div className="panel stack">
      <div>
        <label htmlFor="compose-from">送信元</label>
        <select id="compose-from" value={v.from} onChange={set("from")}>
          {fromOptions.map((o) => (
            <option key={o.email} value={o.email}>
              {o.name ? `${o.name} <${o.email}>` : o.email}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="compose-to">宛先（複数はカンマで区切る）</label>
        <input id="compose-to" type="text" inputMode="email" autoComplete="off" value={v.to} onChange={set("to")} />
      </div>
      <div>
        <label htmlFor="compose-cc">Cc</label>
        <input id="compose-cc" type="text" inputMode="email" autoComplete="off" value={v.cc} onChange={set("cc")} />
      </div>
      <div>
        <label htmlFor="compose-subject">件名</label>
        <input id="compose-subject" value={v.subject} onChange={set("subject")} />
      </div>
      <div>
        <label htmlFor="compose-text">本文</label>
        <textarea id="compose-text" className="draft-text" rows={16} value={v.text} onChange={set("text")} />
      </div>
      {v.attachmentNames.length ? (
        <label className="inline">
          <input type="checkbox" checked={includeAttachments} onChange={(e) => setInclude(e.target.checked)} />
          元の添付ファイルを付ける（{v.attachmentNames.join("、")}）
        </label>
      ) : null}
      {placeholders.length ? (
        <div className="placeholder-list">【要確認】が{placeholders.length}か所残っています。埋めると送信できます</div>
      ) : !v.to.trim() ? (
        <div className="meta">宛先を入れると送信できます</div>
      ) : null}
      <div className="send-row">
        <SendButton
          clientId={clientId}
          email={userEmail}
          disabled={placeholders.length > 0 || !v.to.trim()}
          prepare={async () => {
            const r = await createComposeDraft({
              from: v.from,
              to: v.to,
              cc: v.cc,
              subject: v.subject,
              text: v.text,
              forwardRowId: v.forwardRowId,
              includeAttachments,
              existingDraftId: draftId,
            });
            if (r.ok && r.data) setDraftId(r.data.gmailDraftId);
            return r;
          }}
          after={async (sent) => {
            await recordComposeSent(sent.gmailDraftId, v.subject);
            router.push(withSentNotice("/inbox", `「${v.subject || "(件名なし)"}」を送信しました`, sent.threadId));
          }}
        />
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setSaved(null);
            try {
              const r = await createComposeDraft({
                from: v.from,
                to: v.to,
                cc: v.cc,
                subject: v.subject,
                text: v.text,
                forwardRowId: v.forwardRowId,
                includeAttachments,
                saveOnly: true,
                existingDraftId: draftId,
              });
              if (r.ok && r.data) setDraftId(r.data.gmailDraftId);
              setSaved(r.ok ? "Gmail の下書きに保存しました" : r.error);
            } catch {
              setSaved("保存できませんでした。もう一度試してください");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "保存中…" : "下書きに保存"}
        </button>
        <span className="meta" role="status">
          {saved}
        </span>
      </div>
    </div>
  );
}
