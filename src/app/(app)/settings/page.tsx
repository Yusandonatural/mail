import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { addressMap, auditLog, jobs, playbooks, rules, users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/session";
import { calendarFor } from "@/lib/services";
import { getSetting } from "@/lib/settings";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DATE_KINDS,
  DATE_KIND_LABELS,
  FOLDER_KEYS,
  folderName,
  isFolder,
} from "@/lib/domain";
import { formatJst } from "@/lib/time";
import { SubmitButton } from "@/components/submit-button";
import {
  backfillAction,
  deleteAddressAction,
  deleteRuleAction,
  saveAddressAction,
  saveAutoDraftAction,
  saveBusinessContextAction,
  saveBusinessHoursAction,
  saveCalendarMapAction,
  savePlaybookAction,
  saveRuleAction,
  saveSignaturesAction,
  saveUserAction,
  saveNotifyAction,
  reclassifyAction,
} from "@/app/actions/settings";
import { countUnclassified } from "@/lib/sync";
import { disconnectFreeeAction, selectFreeeCompanyAction } from "@/app/actions/freee";
import { freeeConfigured } from "@/lib/freee";
import { pushConfigured } from "@/lib/notify";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function FolderSelect({ name, value }: { name: string; value?: string }) {
  return (
    <select name={name} defaultValue={value}>
      {FOLDER_KEYS.map((f) => (
        <option key={f} value={f}>
          {folderName(f)}
        </option>
      ))}
    </select>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ freee?: string; backfill?: string }>;
}) {
  const { freee: freeeMessage, backfill: backfillQueued } = await searchParams;
  const admin = await requireAdmin();
  const db = await getDb();
  const [addresses, ruleRows, userRows, playbookRows, logs, failedJobs] = await Promise.all([
    db.select().from(addressMap).orderBy(addressMap.address),
    db.select().from(rules).orderBy(desc(rules.createdAt)),
    db.select().from(users).orderBy(users.email),
    db.select().from(playbooks),
    db.select({ log: auditLog, email: users.email }).from(auditLog).leftJoin(users, eq(users.id, auditLog.userId)).orderBy(desc(auditLog.at)).limit(100),
    db.select().from(jobs).where(eq(jobs.status, "failed")).orderBy(desc(jobs.createdAt)).limit(20),
  ]);
  const pendingJobs = Number(
    ((await db.execute(sql`select count(*) as n from jobs where status in ('pending', 'running')`)) as unknown as {
      rows: Array<{ n: number }>;
    }).rows[0]?.n ?? 0,
  );
  const [signatures, hours, calendarMap, autoDraft, businessContext, freee, notify] = await Promise.all([
    getSetting(db, "signatures"),
    getSetting(db, "businessHours"),
    getSetting(db, "calendarMap"),
    getSetting(db, "autoDraft"),
    getSetting(db, "businessContext"),
    getSetting(db, "freee"),
    getSetting(db, "notify"),
  ]);
  const unclassified = await countUnclassified(db, admin);
  const calendars = await Promise.resolve()
    .then(() => calendarFor(admin).listCalendars())
    .catch(() => []);
  const playbookMap = new Map(playbookRows.map((p) => [p.category, p.guidance]));

  return (
    <>
      <div className="topbar">
        <h1>設定</h1>
      </div>

      <div className="panel">
        <h2>利用者</h2>
        <p className="meta">ここに追加した人だけがログインできます。管理者は全フォルダと設定、担当者は選んだフォルダだけを見られます。</p>
        <table className="simple">
          <thead>
            <tr>
              <th>メール</th>
              <th>役割・見られるフォルダ</th>
              <th>Google 連携</th>
            </tr>
          </thead>
          <tbody>
            {userRows.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>
                  <form action={saveUserAction} className="stack">
                    <input type="hidden" name="email" value={u.email} />
                    <div className="actions">
                      <select name="role" defaultValue={u.role}>
                        <option value="admin">管理者</option>
                        <option value="staff">担当者</option>
                      </select>
                      <select name="active" defaultValue={u.active ? "on" : "off"}>
                        <option value="on">有効</option>
                        <option value="off">無効</option>
                      </select>
                    </div>
                    <div>
                      {FOLDER_KEYS.map((f) => (
                        <label key={f} className="inline">
                          <input type="checkbox" name="visibleFolders" value={f} defaultChecked={u.visibleFolders.includes(f)} />
                          {folderName(f)}
                        </label>
                      ))}
                    </div>
                    <SubmitButton>保存</SubmitButton>
                  </form>
                </td>
                <td className="meta">{u.refreshTokenEnc ? "連携済み" : "未ログイン"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={saveUserAction} className="stack" style={{ marginTop: 10 }}>
          <input type="hidden" name="mode" value="add" />
          <div className="inline-form">
            <div>
              <label>追加するメールアドレス</label>
              <input name="email" type="email" placeholder="staff@yusando.com" required />
            </div>
            <div>
              <label>役割</label>
              <select name="role" defaultValue="staff">
                <option value="staff">担当者</option>
                <option value="admin">管理者</option>
              </select>
            </div>
          </div>
          <div>
            <label>見られるフォルダ（担当者のとき）</label>
            {FOLDER_KEYS.map((f) => (
              <label key={f} className="inline">
                <input type="checkbox" name="visibleFolders" value={f} defaultChecked={f !== "keiri" && f !== "personal"} />
                {folderName(f)}
              </label>
            ))}
          </div>
          <SubmitButton className="primary">追加</SubmitButton>
        </form>
      </div>

      <div className="panel">
        <h2>用途別アドレスとフォルダ</h2>
        <p className="meta">「内容で決める」は個人・総合窓口のアドレス用です。届いたメールの内容で業務フォルダを決め直します。</p>
        <table className="simple">
          <thead>
            <tr>
              <th>アドレス</th>
              <th>フォルダ</th>
              <th>内容で決める</th>
              <th>メモ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {addresses.map((a) => (
              <tr key={a.address}>
                <td>{a.address}</td>
                <td colSpan={3}>
                  <form action={saveAddressAction} className="inline-form">
                    <input type="hidden" name="address" value={a.address} />
                    <div>
                      <FolderSelect name="folder" value={a.folder} />
                    </div>
                    <label className="inline">
                      <input type="checkbox" name="contentDecides" defaultChecked={a.contentDecides} />
                    </label>
                    <div>
                      <input name="note" defaultValue={a.note} />
                    </div>
                    <SubmitButton>保存</SubmitButton>
                  </form>
                </td>
                <td>
                  <form action={deleteAddressAction}>
                    <input type="hidden" name="address" value={a.address} />
                    <SubmitButton className="danger">削除</SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={saveAddressAction} className="inline-form" style={{ marginTop: 10 }}>
          <div>
            <label>アドレスを追加</label>
            <input name="address" type="email" placeholder="xxx@yusando.com" />
          </div>
          <div>
            <label>フォルダ</label>
            <FolderSelect name="folder" />
          </div>
          <label className="inline">
            <input type="checkbox" name="contentDecides" /> 内容で決める
          </label>
          <div>
            <label>メモ</label>
            <input name="note" />
          </div>
          <SubmitButton className="primary">追加</SubmitButton>
        </form>
      </div>

      <div className="panel">
        <h2>送信者ルール</h2>
        <p className="meta">宛先より優先します。メール画面で「今後も」を選んで移動すると、ここに自動で追加されます。</p>
        <table className="simple">
          <tbody>
            {ruleRows.map((r) => (
              <tr key={r.id}>
                <td>{r.kind === "sender" ? r.pattern : `@${r.pattern}（サブドメイン含む）`}</td>
                <td>{isFolder(r.folder) ? folderName(r.folder) : r.folder}</td>
                <td className="meta">{formatJst(r.createdAt)}</td>
                <td>
                  <form action={deleteRuleAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <SubmitButton className="danger">削除</SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
            {!ruleRows.length ? (
              <tr>
                <td className="meta">まだありません</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <form action={saveRuleAction} className="inline-form" style={{ marginTop: 10 }}>
          <div>
            <label>種類</label>
            <select name="kind" defaultValue="domain">
              <option value="domain">ドメイン</option>
              <option value="sender">送信者アドレス</option>
            </select>
          </div>
          <div>
            <label>ドメインまたはアドレス</label>
            <input name="pattern" placeholder="例：tax-office.jp" />
          </div>
          <div>
            <label>フォルダ</label>
            <FolderSelect name="folder" value="keiri" />
          </div>
          <SubmitButton className="primary">追加</SubmitButton>
        </form>
      </div>

      <div className="panel">
        <h2>自動で返信下書きを作るフォルダ</h2>
        <form action={saveAutoDraftAction} className="stack">
          <div>
            {FOLDER_KEYS.map((f) => (
              <label key={f} className="inline">
                <input type="checkbox" name={f} defaultChecked={autoDraft[f]} />
                {folderName(f)}
              </label>
            ))}
          </div>
          <SubmitButton>保存</SubmitButton>
        </form>
      </div>

      <div className="panel">
        <h2>署名</h2>
        <form action={saveSignaturesAction} className="stack">
          <div className="grid2">
            <div>
              <label>日本語</label>
              <textarea name="ja" rows={6} defaultValue={signatures.ja} />
            </div>
            <div>
              <label>英語（日本語以外のメールに使う）</label>
              <textarea name="en" rows={6} defaultValue={signatures.en} />
            </div>
          </div>
          <details>
            <summary>送信元アドレスごとの署名（上書き）</summary>
            {Object.entries(signatures.byAddress).map(([addr, s]) => (
              <div key={addr} className="meta">
                {addr}：{s.ja ? "日本語あり" : ""} {s.en ? "英語あり" : ""}
              </div>
            ))}
            <div className="stack">
              <div>
                <label>アドレス</label>
                <input name="overrideAddress" placeholder="wholesale@yusando.com" />
              </div>
              <div className="grid2">
                <textarea name="overrideJa" rows={5} placeholder="日本語の署名（空で削除）" />
                <textarea name="overrideEn" rows={5} placeholder="英語の署名（空で削除）" />
              </div>
            </div>
          </details>
          <SubmitButton>保存</SubmitButton>
        </form>
      </div>

      <div className="panel">
        <h2>カレンダーと営業時間</h2>
        <form action={saveCalendarMapAction} className="stack">
          <p className="meta">予定の種類ごとに、登録先のカレンダーを選びます。</p>
          <div className="grid2">
            {DATE_KINDS.map((k) => (
              <div key={k}>
                <label>{DATE_KIND_LABELS[k]}</label>
                <select name={k} defaultValue={calendarMap[k]}>
                  <option value="primary">メイン</option>
                  {calendars
                    .filter((c) => !c.primary)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                      </option>
                    ))}
                </select>
              </div>
            ))}
          </div>
          <SubmitButton>保存</SubmitButton>
        </form>
        <form action={saveBusinessHoursAction} className="stack" style={{ marginTop: 16 }}>
          <p className="meta">「候補を3つ提案」で使う営業時間です。</p>
          <div>
            {WEEK.map((w, i) => (
              <label key={i} className="inline">
                <input type="checkbox" name="days" value={i} defaultChecked={hours.days.includes(i)} />
                {w}
              </label>
            ))}
          </div>
          <div className="inline-form">
            <div>
              <label>開始</label>
              <input type="time" name="start" defaultValue={hours.start} />
            </div>
            <div>
              <label>終了</label>
              <input type="time" name="end" defaultValue={hours.end} />
            </div>
            <div>
              <label>1枠（分）</label>
              <input type="number" name="slotMinutes" defaultValue={hours.slotMinutes} min={15} step={15} />
            </div>
            <SubmitButton>保存</SubmitButton>
          </div>
        </form>
      </div>

      <div className="panel">
        <h2>freee 会計</h2>
        {freeeMessage ? <div className="notes">{freeeMessage}</div> : null}
        {!freeeConfigured() ? (
          <p className="meta">
            FREEE_CLIENT_ID と FREEE_CLIENT_SECRET を設定すると連携できます（README を参照）。
          </p>
        ) : freee.refreshTokenEnc ? (
          <div className="stack">
            <p className="meta">
              {freee.connectedBy} が連携しました。経理フォルダのメールから、請求書・領収書の添付を freee のファイルボックスに送れます。
            </p>
            <form action={selectFreeeCompanyAction} className="inline-form">
              <div>
                <label>送り先の事業所</label>
                <select name="companyId" defaultValue={freee.companyId ?? undefined}>
                  {freee.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <SubmitButton>保存</SubmitButton>
            </form>
            <form action={disconnectFreeeAction}>
              <SubmitButton className="danger">連携を解除</SubmitButton>
            </form>
          </div>
        ) : (
          <p>
            <a className="button primary" href="/api/freee/connect" style={{ background: "var(--accent)", color: "#fff" }}>
              freee と連携する
            </a>
          </p>
        )}
      </div>

      <div className="panel">
        <h2>通知</h2>
        {!pushConfigured() ? (
          <p className="meta">VAPID の鍵を設定すると、スマホやパソコンに通知できます（README を参照）。</p>
        ) : (
          <form action={saveNotifyAction} className="stack">
            <p className="meta">各自がメニューの「通知を受け取る」を押した端末に届きます。</p>
            <div>
              <label className="inline">
                <input type="radio" name="mode" value="urgent" defaultChecked={notify.mode === "urgent"} /> 至急の要返信だけ
              </label>
              <label className="inline">
                <input type="radio" name="mode" value="replies" defaultChecked={notify.mode === "replies"} /> 要返信すべて
              </label>
              <label className="inline">
                <input type="radio" name="mode" value="off" defaultChecked={notify.mode === "off"} /> 通知しない
              </label>
            </div>
            <SubmitButton>保存</SubmitButton>
          </form>
        )}
      </div>

      <div className="panel">
        <h2>下書きの書き方</h2>
        <details>
          <summary>会社情報（全ての下書きで Claude に渡します）</summary>
          <form action={saveBusinessContextAction} className="stack">
            <textarea name="businessContext" rows={14} defaultValue={businessContext} />
            <SubmitButton>保存</SubmitButton>
          </form>
        </details>
        {CATEGORIES.map((c) => (
          <details key={c}>
            <summary>{CATEGORY_LABELS[c]}</summary>
            <form action={savePlaybookAction} className="stack">
              <input type="hidden" name="category" value={c} />
              <textarea name="guidance" rows={8} defaultValue={playbookMap.get(c) ?? ""} />
              <SubmitButton>保存</SubmitButton>
            </form>
          </details>
        ))}
      </div>

      <div className="panel">
        <h2 id="backfill">過去のメールの取り込み</h2>
        {backfillQueued ? <div className="notes">{backfillQueued} 通を取り込みの順番待ちに入れました。新しく届くメールを優先して、5分ごとに少しずつ進みます。</div> : null}
        <p className="meta">あなたの受信箱にある過去のメールを、さかのぼって分類します（下書きは自動では作りません）。</p>
        <form action={backfillAction} className="inline-form">
          <div>
            <label>何日分</label>
            <input type="number" name="days" defaultValue={30} min={1} max={365} />
          </div>
          <SubmitButton>取り込む</SubmitButton>
        </form>
        {unclassified ? (
          <form action={reclassifyAction} className="stack" style={{ marginTop: 12 }}>
            <p className="meta">
              Claude で分類できていないメールが {unclassified} 通あります（以前の不具合で分類に失敗したもの、一斉配信として分類を省いたもの）。
              分類し直すと、フォルダとラベルが付け直されます。人が直したものとルールで決まったものは変わりません。
            </p>
            <div>
              <SubmitButton>分類し直す</SubmitButton>
            </div>
          </form>
        ) : null}
        <p className="meta">処理待ちのジョブ：{pendingJobs} 件</p>
        {failedJobs.length ? (
          <details>
            <summary>失敗したジョブ（{failedJobs.length}）</summary>
            <table className="simple">
              <tbody>
                {failedJobs.map((j) => (
                  <tr key={j.id}>
                    <td>{j.kind}</td>
                    <td className="meta">{j.lastError}</td>
                    <td className="meta">{formatJst(j.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>

      <div className="panel">
        <h2>操作の記録</h2>
        <table className="simple">
          <tbody>
            {logs.map(({ log, email }) => (
              <tr key={log.id}>
                <td className="meta" style={{ width: 130 }}>
                  {formatJst(log.at)}
                </td>
                <td>{email ?? "システム"}</td>
                <td>{log.action}</td>
                <td className="meta">{log.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
