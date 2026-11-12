import Link from "next/link";
import type { ListedMessage } from "@/lib/queries";
import { folderName, isFolder, LANGUAGE_LABELS, type Language } from "@/lib/domain";
import { formatListTime } from "@/lib/time";

export function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return "";
  if (!currency || currency === "JPY") return `¥${amount.toLocaleString("ja-JP")}`;
  return `${amount.toLocaleString("en-US")} ${currency}`;
}

const AVATAR_HUES = [211, 262, 330, 14, 32, 152, 188, 236];

/** 送信者ごとに決まった色の丸いアイコン（頭文字） */
export function Avatar({ name, email }: { name: string; email: string }) {
  let h = 0;
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  const initial = (name.replace(/^["'\s]+/, "")[0] ?? email[0] ?? "?").toUpperCase();
  return (
    <span className="avatar" style={{ "--hue": hue } as React.CSSProperties} aria-hidden="true">
      {initial}
    </span>
  );
}

export function MessageRowView({
  m,
  keiri,
  showFolder,
  back,
  now,
}: {
  m: ListedMessage;
  keiri: boolean;
  showFolder: boolean;
  back: string;
  now?: Date;
}) {
  // 行はスレッドの最新のメールだが、要返信・下書きはスレッドの中のどれか1通にあれば出す
  // （要返信のメールの後に、返信の要らない「追伸」や自動返信が届いた場合など）
  const open = m.threadOpen || (m.needsReply && (m.status === "new" || m.status === "draft_ready"));
  const urgent = m.threadUrgent || (open && m.urgency === "high");
  const draft = m.threadDraft || m.status === "draft_ready";
  const unread = m.threadUnread || m.unread;
  const sender = m.fromName || m.fromEmail;
  // 左端の細い帯で状態を示す：至急＞要返信＞下書きあり＞要確認
  const state = urgent
    ? "state-urgent"
    : open && !draft
      ? "state-reply"
      : draft
        ? "state-draft"
        : m.needsReview
          ? "state-review"
          : "";
  // チェックと行ごとのボタンは、一覧を囲む form（bulkRemoveAction）に送られる
  return (
    <div className={["row-line", state, unread ? "is-unread" : ""].filter(Boolean).join(" ")}>
      <label className="pick" title="選択（x）">
        <Avatar name={sender} email={m.fromEmail} />
        <input type="checkbox" name="sel" value={m.id} aria-label={`${sender}「${m.subject}」を選択`} />
      </label>
      <Link href={`/m/${m.id}?back=${encodeURIComponent(back)}`} className={["row", unread ? "unread" : ""].filter(Boolean).join(" ")}>
        <div className="row-top">
          <span className="who">
            {sender}
            {m.threadCount > 1 ? <span className="thread-count">{m.threadCount}</span> : null}
          </span>
          {keiri && m.amount !== null ? <span className="amount">{formatAmount(m.amount, m.currency)}</span> : null}
          <span className="when">{formatListTime(m.receivedAt, now)}</span>
        </div>
        <div className="subject">{m.subject || "(件名なし)"}</div>
        {m.summary ? <div className="summary">{m.summary}</div> : null}
        <div className="badges">
          {urgent ? <span className="badge high">至急</span> : null}
          {open && !draft ? <span className="badge reply">要返信</span> : null}
          {draft ? <span className="badge draft">下書きあり</span> : null}
          {m.needsReview ? <span className="badge review">要確認</span> : null}
          {m.suggestConfirm ? <span className="badge draft">確定の提案</span> : null}
          {m.hasDates ? <span className="badge date">日程あり</span> : null}
          {keiri && m.dueDate ? <span className="badge date">期限 {m.dueDate}</span> : null}
          {showFolder && isFolder(m.folder) ? <span className={`badge folder f-${m.folder}`}>{folderName(m.folder)}</span> : null}
          {m.language !== "ja" ? <span className="badge">{LANGUAGE_LABELS[m.language as Language] ?? m.language}</span> : null}
          {m.hasAttachments ? <span className="badge">添付</span> : null}
          {m.freeeSent ? <span className="badge draft">freee済</span> : null}
          {!keiri && m.amount !== null ? <span className="badge">{formatAmount(m.amount, m.currency)}</span> : null}
        </div>
      </Link>
      <div className="quick">
        <button type="submit" name="only" value={`spam:${m.id}`} data-spam title="迷惑メールにする（!）">
          迷惑
        </button>
        <button type="submit" name="only" value={`trash:${m.id}`} data-trash title="ゴミ箱へ（#）">
          削除
        </button>
      </div>
    </div>
  );
}
