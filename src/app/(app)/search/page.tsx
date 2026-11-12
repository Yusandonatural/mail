import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { canSeeMessage, visibleFolders } from "@/lib/access";
import { folderName, isFolder } from "@/lib/domain";
import { buildQuery } from "@/lib/search";
import { mailFor } from "@/lib/services";
import { parseMessage, type ParsedMessage } from "@/lib/mail/parse";
import { formatJst } from "@/lib/time";
import { SubmitButton } from "@/components/submit-button";
import { Avatar } from "@/components/message-row";
import { importMessageAction } from "@/app/actions/mail";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; folder?: string; after?: string; before?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const q = sp.q ?? "";
  const folder = sp.folder && isFolder(sp.folder) ? sp.folder : null;
  const query = buildQuery(q, folder, sp.after ?? "", sp.before ?? "");
  // 取り込めなかったときに戻る、この検索の URL
  const self = `/search?${new URLSearchParams(
    Object.entries({ q, folder: folder ?? "", after: sp.after ?? "", before: sp.before ?? "" }).filter(([, v]) => v),
  ).toString()}`;

  let results: Array<{ parsed: ParsedMessage; rowId: number | null; hidden: boolean }> = [];
  let error: string | null = null;
  if (query) {
    try {
      const mail = mailFor(user);
      const ids = await mail.listMessageIds(query, 50);
      const db = await getDb();
      const rows = ids.length
        ? await db
            .select()
            .from(messages)
            .where(and(eq(messages.userId, user.id), inArray(messages.gmailMessageId, ids)))
        : [];
      const byId = new Map(rows.map((r) => [r.gmailMessageId, r]));
      const parsed: ParsedMessage[] = [];
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = await Promise.all(ids.slice(i, i + 10).map((id) => mail.getMessage(id)));
        parsed.push(...chunk.map(parseMessage));
      }
      results = parsed.map((p) => {
        const row = byId.get(p.id);
        return { parsed: p, rowId: row?.id ?? null, hidden: row ? !canSeeMessage(user, row) : false };
      });
      results = results.filter((r) => !r.hidden);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>検索</h1>
      </div>
      <form className="panel inline-form" method="get" role="search">
        <div style={{ flex: 3, minWidth: 220 }}>
          <label htmlFor="search-q">キーワード</label>
          <input id="search-q" type="search" name="q" defaultValue={q} placeholder="相手・件名・本文の言葉" autoFocus />
        </div>
        <div>
          <label htmlFor="search-folder">フォルダ</label>
          <select id="search-folder" name="folder" defaultValue={folder ?? ""}>
            <option value="">すべて</option>
            {visibleFolders(user).map((f) => (
              <option key={f} value={f}>
                {folderName(f)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="search-after">この日以降</label>
          <input id="search-after" type="date" name="after" defaultValue={sp.after ?? ""} />
        </div>
        <div>
          <label htmlFor="search-before">この日より前</label>
          <input id="search-before" type="date" name="before" defaultValue={sp.before ?? ""} />
        </div>
        <button type="submit" className="primary">
          検索
        </button>
      </form>
      {!query ? (
        <p className="meta">Gmail と同じ書き方が使えます。例：from:tanaka@example.co.jp（差出人）、has:attachment（添付あり）、&quot;抹茶 500g&quot;（その言葉どおり）</p>
      ) : null}
      {error ? (
        <div className="banner error" role="alert">
          <span>Gmail で検索できませんでした：{error}</span>
        </div>
      ) : null}
      {query && !error ? (
        <>
          {results.length ? <h2 className="list-title">{results.length >= 50 ? "新しい順に50件" : `${results.length}件`}</h2> : null}
          <div className="list">
            {results.length ? (
              results.map(({ parsed: p, rowId }) => {
                const sender = p.from?.name || p.from?.email || "";
                const body = (
                  <>
                    <div className="row-top">
                      <span className="who">{sender}</span>
                      <span className="when">{formatJst(p.date)}</span>
                    </div>
                    <div className="subject">{p.subject || "(件名なし)"}</div>
                    <div className="summary">{p.text.replace(/\s+/g, " ").slice(0, 120)}</div>
                  </>
                );
                return (
                  <div key={p.id} className="row-line">
                    <span className="pick">
                      <Avatar name={sender} email={p.from?.email ?? ""} />
                    </span>
                    {rowId ? (
                      <Link href={`/m/${rowId}?back=${encodeURIComponent(`/search?q=${encodeURIComponent(q)}`)}`} className="row">
                        {body}
                      </Link>
                    ) : (
                      <>
                        <div className="row">{body}</div>
                        <form action={importMessageAction} className="row-action">
                          <input type="hidden" name="gmailMessageId" value={p.id} />
                          <input type="hidden" name="back" value={self} />
                          <SubmitButton>取り込んで開く</SubmitButton>
                        </form>
                      </>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="empty">見つかりませんでした。言葉を変えるか、フォルダや日付を外してみてください</div>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
