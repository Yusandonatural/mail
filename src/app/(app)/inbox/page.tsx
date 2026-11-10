import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeFolder } from "@/lib/access";
import { folderName, isFolder } from "@/lib/domain";
import { FILTER_LABELS, listMessages, type ListFilter } from "@/lib/queries";
import { MessageRowView } from "@/components/message-row";
import { BulkBar } from "@/components/bulk-bar";
import { bulkRemoveAction } from "@/app/actions/mail";

const FILTERS = Object.keys(FILTER_LABELS) as ListFilter[];
const DRAFTS_SHOWN = 10;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; filter?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const folder = sp.folder && isFolder(sp.folder) ? sp.folder : null;
  if (folder && !canSeeFolder(user, folder)) notFound();
  const filter: ListFilter = FILTERS.includes(sp.filter as ListFilter) ? (sp.filter as ListFilter) : "all";
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const db = await getDb();
  // 受信箱（全て）の一番上に、Claude が作った返信下書きを全フォルダからまとめて出す（朝の確認用）
  const showDrafts = !folder && filter === "all";
  const draftRows = showDrafts && page === 0 ? await listMessages(db, user, { folder: null, filter: "draft", page: 0, pageSize: DRAFTS_SHOWN }) : [];
  const fetched = await listMessages(db, user, { folder, filter, page, excludeDrafts: showDrafts });
  const hasMore = fetched.length > 50;
  const rows = fetched.slice(0, 50);
  const keiri = folder === "keiri";
  const qs = (over: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | number | null> = { folder, filter: filter === "all" ? null : filter, page: null, ...over };
    for (const [k, v] of Object.entries(merged)) if (v !== null && v !== "" && v !== 0) p.set(k, String(v));
    const s = p.toString();
    return s ? `/inbox?${s}` : "/inbox";
  };

  return (
    <>
      <div className="topbar">
        <h1>{folder ? folderName(folder) : "受信箱（全て）"}</h1>
        {!folder ? <span className="meta">フォルダに振り分けたメールは、左の各フォルダにあります</span> : null}
        <div className="filters">
          {FILTERS.map((f) => (
            <Link key={f} href={qs({ filter: f === "all" ? null : f })} className={f === filter ? "active" : undefined}>
              {FILTER_LABELS[f]}
            </Link>
          ))}
        </div>
      </div>
      <form action={bulkRemoveAction} className="bulk">
        <input type="hidden" name="back" value={qs({ page: page || null })} />
        {rows.length || draftRows.length ? <BulkBar /> : null}
        {draftRows.length ? (
          <section className="draft-queue" aria-labelledby="draft-queue-title">
            <div className="draft-queue-head">
              <h2 id="draft-queue-title">Claude の返信下書き</h2>
              <span className="meta">
                確認して送るだけのメール {draftRows.length > DRAFTS_SHOWN ? `${DRAFTS_SHOWN}件以上` : `${draftRows.length}件`}・全フォルダから新しい順
              </span>
              {draftRows.length > DRAFTS_SHOWN ? <Link href={qs({ filter: "draft" })}>すべて見る →</Link> : null}
            </div>
            <div className="list">
              {draftRows.slice(0, DRAFTS_SHOWN).map((m) => (
                <MessageRowView key={m.id} m={m} keiri={false} showFolder back={qs({ page: page || null })} />
              ))}
            </div>
          </section>
        ) : null}
        {draftRows.length && rows.length ? <h2 className="list-title">そのほかの振り分け前のメール</h2> : null}
        <div className="list">
          {rows.length ? (
            rows.map((m) => <MessageRowView key={m.id} m={m} keiri={keiri} showFolder={!folder} back={qs({ page: page || null })} />)
          ) : (
            <div className="empty">
              {folder
                ? "このフォルダにメールはありません"
                : draftRows.length
                  ? "ほかに振り分け前のメールはありません"
                  : "振り分け前のメールはありません。左の各フォルダをご覧ください"}
            </div>
          )}
        </div>
      </form>
      <div className="actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
        <span className="kbd">j / k で移動、Enter で開く、x で選択、! で迷惑メール、# で削除、/ で検索</span>
        <span className="actions">
          {page > 0 ? <Link href={qs({ page: page - 1 })}>← 新しいメール</Link> : null}
          {hasMore ? <Link href={qs({ page: page + 1 })}>古いメール →</Link> : null}
        </span>
      </div>
    </>
  );
}
