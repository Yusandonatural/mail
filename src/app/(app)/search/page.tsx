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
      <form className="panel inline-form" method="get">
        <div style={{ flex: 3 }}>
          <label>キーワード（宛先・件名・本文。from: や has:attachment も使えます）</label>
          <input name="q" defaultValue={q} autoFocus />
        </div>
        <div>
          <label>フォルダ</label>
          <select name="folder" defaultValue={folder ?? ""}>
            <option value="">すべて</option>
            {visibleFolders(user).map((f) => (
              <option key={f} value={f}>
                {folderName(f)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>この日以降</label>
          <input type="date" name="after" defaultValue={sp.after ?? ""} />
        </div>
        <div>
          <label>この日より前</label>
          <input type="date" name="before" defaultValue={sp.before ?? ""} />
        </div>
        <button type="submit" className="primary">
          検索
        </button>
      </form>
      {error ? <div className="banner error">{error}</div> : null}
      {query ? (
        <div className="list">
          {results.length ? (
            results.map(({ parsed: p, rowId }) =>
              rowId ? (
                <Link key={p.id} href={`/m/${rowId}`} className="row">
                  <div className="who">{p.from?.name || p.from?.email}</div>
                  <div className="subject">{p.subject || "(件名なし)"}</div>
                  <div className="when">{formatJst(p.date)}</div>
                </Link>
              ) : (
                <div key={p.id} className="row">
                  <div className="who">{p.from?.name || p.from?.email}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="subject">{p.subject || "(件名なし)"}</div>
                    <div className="summary">{p.text.slice(0, 120)}</div>
                  </div>
                  <form action={importMessageAction}>
                    <input type="hidden" name="gmailMessageId" value={p.id} />
                    <SubmitButton>取り込んで開く</SubmitButton>
                  </form>
                </div>
              ),
            )
          ) : (
            <div className="empty">見つかりませんでした</div>
          )}
        </div>
      ) : null}
    </>
  );
}
