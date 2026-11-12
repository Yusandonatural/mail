import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeFolder } from "@/lib/access";
import { folderName, isFolder } from "@/lib/domain";
import { FILTER_LABELS, filterCounts, listMessages, unreadNewsletterCount, type ListedMessage, type ListFilter } from "@/lib/queries";
import { dayGroupLabel } from "@/lib/time";
import { MessageRowView } from "@/components/message-row";
import { BulkBar } from "@/components/bulk-bar";
import { bulkRemoveAction } from "@/app/actions/mail";

const FILTERS = Object.keys(FILTER_LABELS) as ListFilter[];
const PAGE = 50;

/** 新しい順の一覧を「今日・昨日・この1週間・○月」の見出しごとに分ける */
function groupByDay(rows: ListedMessage[], now: Date): Array<{ label: string; rows: ListedMessage[] }> {
  const groups: Array<{ label: string; rows: ListedMessage[] }> = [];
  for (const m of rows) {
    const label = dayGroupLabel(m.receivedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(m);
    else groups.push({ label, rows: [m] });
  }
  return groups;
}

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
  const [fetched, counts, newsletters] = await Promise.all([
    listMessages(db, user, { folder, filter, page, pageSize: PAGE }),
    filterCounts(db, user, folder),
    !folder && filter === "all" && page === 0 ? unreadNewsletterCount(db, user) : Promise.resolve(0),
  ]);
  const hasMore = fetched.length > PAGE;
  const rows = fetched.slice(0, PAGE);
  const keiri = folder === "keiri";
  const now = new Date();
  const qs = (over: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | number | null> = { folder, filter: filter === "all" ? null : filter, page: null, ...over };
    for (const [k, v] of Object.entries(merged)) if (v !== null && v !== "" && v !== 0) p.set(k, String(v));
    const s = p.toString();
    return s ? `/inbox?${s}` : "/inbox";
  };
  const back = qs({ page: page || null });
  const countFor: Partial<Record<ListFilter, number>> = counts;

  return (
    <>
      <div className="topbar">
        <h1>{folder ? folderName(folder) : "受信箱"}</h1>
        <nav className="filters" aria-label="絞り込み">
          {FILTERS.map((f) => (
            <Link key={f} href={qs({ filter: f === "all" ? null : f })} className={f === filter ? "active" : undefined}>
              {FILTER_LABELS[f]}
              {countFor[f] ? <span className="filter-count">{countFor[f]}</span> : null}
            </Link>
          ))}
        </nav>
      </div>
      {newsletters ? (
        <Link className="bundle" href="/inbox?folder=info">
          <span className="bundle-icon" aria-hidden="true">
            ✉
          </span>
          <span>
            <strong>ニュースレター・お知らせ</strong>
            <span className="meta">未読 {newsletters}件。受信箱には出さず、まとめています</span>
          </span>
          <span className="bundle-go" aria-hidden="true">
            ›
          </span>
        </Link>
      ) : null}
      <form action={bulkRemoveAction} className="bulk">
        <input type="hidden" name="back" value={back} />
        {rows.length ? <BulkBar /> : null}
        {rows.length ? (
          groupByDay(rows, now).map((g) => (
            <section key={g.label} className="day-group" aria-label={g.label}>
              <h2 className="day-label">
                {g.label}
                <span className="day-count">{g.rows.length}</span>
              </h2>
              <div className="list">
                {g.rows.map((m) => (
                  <MessageRowView key={m.id} m={m} keiri={keiri} showFolder={!folder} back={back} now={now} />
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="list">
            <div className="empty">{filter === "all" ? "メールはありません" : `「${FILTER_LABELS[filter]}」のメールはありません`}</div>
          </div>
        )}
      </form>
      <div className="pager">
        <span className="kbd">j / k で移動、Enter で開く、x で選択、! で迷惑メール、# で削除、/ で検索</span>
        <span className="actions">
          {page > 0 ? <Link href={qs({ page: page - 1 })}>← 新しいメール</Link> : null}
          {hasMore ? <Link href={qs({ page: page + 1 })}>古いメール →</Link> : null}
        </span>
      </div>
    </>
  );
}
