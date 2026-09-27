import Link from "next/link";
import type { ListedMessage } from "@/lib/queries";
import { folderName, isFolder, LANGUAGE_LABELS, type Language } from "@/lib/domain";
import { formatJst } from "@/lib/time";

export function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return "";
  if (!currency || currency === "JPY") return `¥${amount.toLocaleString("ja-JP")}`;
  return `${amount.toLocaleString("en-US")} ${currency}`;
}

export function MessageRowView({ m, keiri, showFolder }: { m: ListedMessage; keiri: boolean; showFolder: boolean }) {
  const open = m.needsReply && (m.status === "new" || m.status === "draft_ready");
  return (
    <Link href={`/m/${m.id}`} className={["row", keiri ? "keiri" : "", m.unread ? "unread" : ""].join(" ")}>
      <div className="who">{m.fromName || m.fromEmail}</div>
      <div style={{ minWidth: 0 }}>
        <div className="subject">{m.subject || "(件名なし)"}</div>
        <div className="summary">{m.summary}</div>
        <div className="badges">
          {m.urgency === "high" && open ? <span className="badge high">至急</span> : null}
          {open && m.status === "new" ? <span className="badge reply">要返信</span> : null}
          {m.status === "draft_ready" ? <span className="badge draft">下書きあり</span> : null}
          {m.needsReview ? <span className="badge review">要確認</span> : null}
          {m.suggestConfirm ? <span className="badge draft">確定の提案</span> : null}
          {m.hasDates ? <span className="badge date">日程あり</span> : null}
          {m.language !== "ja" ? <span className="badge">{LANGUAGE_LABELS[m.language as Language] ?? m.language}</span> : null}
          {m.hasAttachments ? <span className="badge">添付</span> : null}
          {m.freeeSent ? <span className="badge draft">freee済</span> : null}
          {showFolder && isFolder(m.folder) ? <span className="badge">{folderName(m.folder)}</span> : null}
          {!keiri && m.amount !== null ? <span className="badge">{formatAmount(m.amount, m.currency)}</span> : null}
        </div>
      </div>
      {keiri ? <div className="amount">{formatAmount(m.amount, m.currency)}</div> : null}
      {keiri ? <div className="due meta">{m.dueDate ? `期限 ${m.dueDate}` : ""}</div> : null}
      <div className="when">{formatJst(m.receivedAt)}</div>
    </Link>
  );
}
