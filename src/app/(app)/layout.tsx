import { Suspense } from "react";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { visibleFolders } from "@/lib/access";
import { folderName } from "@/lib/domain";
import { folderCounts } from "@/lib/queries";
import { NavLink } from "@/components/nav-link";
import { KeyboardNav } from "@/components/keyboard-nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const db = await getDb();
  const counts = await folderCounts(db, user);
  const folders = visibleFolders(user);
  const totalReply = folders.reduce((n, f) => n + (counts.get(f)?.reply ?? 0), 0);

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/inbox">
          悠三堂メール
        </a>
        <Suspense>
          <nav className="nav">
            <NavLink href="/compose">＋ 新規作成</NavLink>
            <NavLink href="/inbox" count={totalReply} hot>
              受信箱（全て）
            </NavLink>
            <NavLink href="/today">今日・今週の予定</NavLink>
            <NavLink href="/search">検索</NavLink>
          </nav>
          <div className="nav-section">フォルダ</div>
          <nav className="nav folders">
            {folders.map((f) => {
              const c = counts.get(f);
              return (
                <NavLink key={f} href={`/inbox?folder=${f}`} count={c?.reply || c?.unread || 0} hot={Boolean(c?.reply)}>
                  {folderName(f)}
                </NavLink>
              );
            })}
          </nav>
          {user.role === "admin" ? (
            <>
              <div className="nav-section">管理</div>
              <nav className="nav">
                <NavLink href="/settings">設定</NavLink>
              </nav>
            </>
          ) : null}
        </Suspense>
        <div className="nav-section">{user.email}</div>
        <form action="/api/auth/logout" method="post" style={{ padding: "0 8px" }}>
          <button type="submit">ログアウト</button>
        </form>
      </aside>
      <main className="main">{children}</main>
      <KeyboardNav />
    </div>
  );
}
