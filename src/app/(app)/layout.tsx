import { Suspense } from "react";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { visibleFolders } from "@/lib/access";
import { folderName } from "@/lib/domain";
import { folderCounts, totalReplyCount } from "@/lib/queries";
import { NavLink } from "@/components/nav-link";
import { KeyboardNav } from "@/components/keyboard-nav";
import { NotifyToggle } from "@/components/notify-toggle";
import { NoticeBanner } from "@/components/notice-banner";
import { vapidPublicKey } from "@/lib/notify";
import { claudeFailing, getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const db = await getDb();
  // どのページでも読むので、まとめて並行に問い合わせる
  const [counts, totalReply, claudeHealth] = await Promise.all([
    folderCounts(db, user),
    totalReplyCount(db, user),
    getSetting(db, "claudeHealth"),
  ]);
  const folders = visibleFolders(user);

  const claudeFailure = claudeFailing(claudeHealth);

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/inbox" aria-label="悠三堂メール 受信箱へ">
          <span className="seal" aria-hidden="true">
            悠
          </span>
          <span className="brand-name">悠三堂メール</span>
        </a>
        <Suspense>
          <NavLink href="/compose" icon="compose" className="compose-link">
            新規作成
          </NavLink>
          <nav className="nav">
            <NavLink href="/inbox" icon="inbox" count={totalReply} hot>
              受信箱
            </NavLink>
            <NavLink href="/today" icon="calendar">
              今日・今週の予定
            </NavLink>
            <NavLink href="/search" icon="search">
              検索
            </NavLink>
          </nav>
          <div className="nav-section">フォルダ</div>
          <nav className="nav folders">
            {folders.map((f) => {
              const c = counts.get(f);
              return (
                <NavLink key={f} href={`/inbox?folder=${f}`} dot={f} count={f === "info" ? c?.unread ?? 0 : c?.reply ?? 0} hot={f !== "info"}>
                  {folderName(f)}
                </NavLink>
              );
            })}
          </nav>
          {user.role === "admin" ? (
            <nav className="nav nav-bottom">
              <NavLink href="/settings" icon="settings">
                設定
              </NavLink>
            </nav>
          ) : null}
        </Suspense>
        {vapidPublicKey() ? <NotifyToggle publicKey={vapidPublicKey()!} /> : null}
        <div className="account">
          <span className="meta">{user.email}</span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="link-button">
              ログアウト
            </button>
          </form>
        </div>
      </aside>
      <main className="main">
        {claudeFailure ? (
          <div className="banner error" role="alert">
            <strong>Claude で分類できていません。</strong>
            <span>
              {claudeFailure}。直るまでのメールは「個人・要確認」に入ります。
              {user.role === "admin" ? (
                <>
                  {" "}
                  <a href="/settings#claude">設定で接続を確かめる</a>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
        <Suspense>
          <NoticeBanner userEmail={user.email} />
        </Suspense>
        {children}
      </main>
      <KeyboardNav />
    </div>
  );
}
