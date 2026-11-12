import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { addressMap, auditLog, jobs, playbooks, rules, users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/session";
import { calendarFor } from "@/lib/services";
import { claudeFailing, getSetting } from "@/lib/settings";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DATE_KINDS,
  DATE_KIND_LABELS,
  FOLDER_KEYS,
  folderName,
  ruleTargetName,
  BLOCK_RULE,
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
  testClaudeAction,
  testShopifyAction,
} from "@/app/actions/settings";
import { shopFromEnv } from "@/lib/shopify";
import { countUnclassified } from "@/lib/sync";
import { disconnectFreeeAction, selectFreeeCompanyAction } from "@/app/actions/freee";
import { freeeConfigured } from "@/lib/freee";
import { pushConfigured } from "@/lib/notify";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** ページ上部の目次（長い設定ページを行き来しやすく） */
const JUMPS: Array<[string, string]> = [
  ["users", "利用者"],
  ["addresses", "アドレス"],
  ["rules", "送信者ルール"],
  ["auto-draft", "自動下書き"],
  ["signatures", "署名"],
  ["calendar", "カレンダー"],
  ["freee", "freee"],
  ["notify", "通知"],
  ["playbooks", "書き方"],
  ["claude", "Claude"],
  ["backfill", "取り込み"],
  ["audit", "記録"],
];

function FolderSelect({ name, value, withBlock, id, label }: { name: string; value?: string; withBlock?: boolean; id?: string; label?: string }) {
  return (
    <select name={name} defaultValue={value} id={id} aria-label={label}>
      {FOLDER_KEYS.map((f) => (
        <option key={f} value={f}>
          {folderName(f)}
        </option>
      ))}
      {withBlock ? <option value={BLOCK_RULE}>{ruleTargetName(BLOCK_RULE)}</option> : null}
    </select>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ freee?: string; backfill?: string; claude?: string; shopify?: string }>;
}) {
  const { freee: freeeMessage, backfill: backfillQueued, claude: claudeTest, shopify: shopifyTest } = await searchParams;
  const admin = await requireAdmin();
  const db = await getDb();
  const claudeHealth = await getSetting(db, "claudeHealth");
  const claudeFailure = claudeFailing(claudeHealth);
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
    <div className="settings">
      <div className="topbar">
        <h1>設定</h1>
      </div>
      <nav className="jump-nav" aria-label="設定の項目">
        {JUMPS.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <section className="panel" aria-labelledby="users">
        <h2 id="users">利用者</h2>
        <p className="meta">ここに追加した人だけがログインできます。管理者は全フォルダと設定、担当者は選んだフォルダだけを見られます。</p>
        <table className="simple rtable">
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
                <td>
                  <strong>{u.email}</strong>
                </td>
                <td>
                  <form action={saveUserAction} className="stack">
                    <input type="hidden" name="email" value={u.email} />
                    <div className="actions">
                      <select name="role" defaultValue={u.role} aria-label={`${u.email} の役割`} style={{ width: "auto" }}>
                        <option value="admin">管理者</option>
                        <option value="staff">担当者</option>
                      </select>
                      <select name="active" defaultValue={u.active ? "on" : "off"} aria-label={`${u.email} を有効にするか`} style={{ width: "auto" }}>
                        <option value="on">有効</option>
                        <option value="off">無効</option>
                      </select>
                    </div>
                    <div className="checks">
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
                <td className="meta">
                  <span className="rtable-label">Google 連携：</span>
                  {u.refreshTokenEnc ? "連携済み" : "未ログイン"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={saveUserAction} className="stack" style={{ marginTop: 10 }}>
          <input type="hidden" name="mode" value="add" />
          <div className="inline-form">
            <div>
              <label htmlFor="add-user-email">追加するメールアドレス</label>
              <input id="add-user-email" name="email" type="email" placeholder="staff@yusando.com" required />
            </div>
            <div>
              <label htmlFor="add-user-role">役割</label>
              <select id="add-user-role" name="role" defaultValue="staff">
                <option value="staff">担当者</option>
                <option value="admin">管理者</option>
              </select>
            </div>
          </div>
          <fieldset className="plain">
            <legend>見られるフォルダ（担当者のとき）</legend>
            <div className="checks">
              {FOLDER_KEYS.map((f) => (
                <label key={f} className="inline">
                  <input type="checkbox" name="visibleFolders" value={f} defaultChecked={f !== "keiri" && f !== "personal"} />
                  {folderName(f)}
                </label>
              ))}
            </div>
          </fieldset>
          <SubmitButton className="primary">追加</SubmitButton>
        </form>
      </section>

      <section className="panel" aria-labelledby="addresses">
        <h2 id="addresses">用途別アドレスとフォルダ</h2>
        <p className="meta">「内容で決める」は個人・総合窓口のアドレス用です。届いたメールの内容で業務フォルダを決め直します。</p>
        <table className="simple rtable">
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
                <td>
                  <strong>{a.address}</strong>
                </td>
                <td colSpan={3}>
                  <form action={saveAddressAction} className="inline-form">
                    <input type="hidden" name="address" value={a.address} />
                    <div>
                      <FolderSelect name="folder" value={a.folder} label={`${a.address} のフォルダ`} />
                    </div>
                    <label className="inline">
                      <input type="checkbox" name="contentDecides" defaultChecked={a.contentDecides} />
                      <span className="visually-hidden">{a.address} は</span>内容で決める
                    </label>
                    <div>
                      <input name="note" defaultValue={a.note} aria-label={`${a.address} のメモ`} placeholder="メモ" />
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
            {!addresses.length ? (
              <tr>
                <td className="meta" colSpan={5}>
                  まだありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <form action={saveAddressAction} className="inline-form" style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="add-address">アドレスを追加</label>
            <input id="add-address" name="address" type="email" placeholder="xxx@yusando.com" />
          </div>
          <div>
            <label htmlFor="add-address-folder">フォルダ</label>
            <FolderSelect name="folder" id="add-address-folder" />
          </div>
          <label className="inline">
            <input type="checkbox" name="contentDecides" /> 内容で決める
          </label>
          <div>
            <label htmlFor="add-address-note">メモ</label>
            <input id="add-address-note" name="note" />
          </div>
          <SubmitButton className="primary">追加</SubmitButton>
        </form>
      </section>

      <section className="panel" aria-labelledby="rules">
        <h2 id="rules">送信者ルール</h2>
        <p className="meta">宛先より優先します。メール画面で「今後も」を選んで移動すると、ここに自動で追加されます。「迷惑メール（自動）」にした送信者のメールは、届いた時点で迷惑メールへ移します（削除すると元に戻ります）。</p>
        <table className="simple">
          <tbody>
            {ruleRows.map((r) => (
              <tr key={r.id}>
                <td>{r.kind === "sender" ? r.pattern : `@${r.pattern}（サブドメイン含む）`}</td>
                <td>{ruleTargetName(r.folder)}</td>
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
            <label htmlFor="rule-kind">種類</label>
            <select id="rule-kind" name="kind" defaultValue="domain">
              <option value="domain">ドメイン</option>
              <option value="sender">送信者アドレス</option>
            </select>
          </div>
          <div>
            <label htmlFor="rule-pattern">ドメインまたはアドレス</label>
            <input id="rule-pattern" name="pattern" placeholder="例：tax-office.jp" />
          </div>
          <div>
            <label htmlFor="rule-folder">フォルダ</label>
            <FolderSelect name="folder" value="keiri" withBlock id="rule-folder" />
          </div>
          <SubmitButton className="primary">追加</SubmitButton>
        </form>
      </section>

      <section className="panel" aria-labelledby="auto-draft">
        <h2 id="auto-draft">自動で返信下書きを作るフォルダ</h2>
        <form action={saveAutoDraftAction} className="stack">
          <div className="checks">
            {FOLDER_KEYS.map((f) => (
              <label key={f} className="inline">
                <input type="checkbox" name={f} defaultChecked={autoDraft[f]} />
                {folderName(f)}
              </label>
            ))}
          </div>
          <SubmitButton>保存</SubmitButton>
        </form>
      </section>

      <section className="panel" aria-labelledby="signatures">
        <h2 id="signatures">署名</h2>
        <form action={saveSignaturesAction} className="stack">
          <div className="grid2">
            <div>
              <label htmlFor="sig-ja">日本語</label>
              <textarea id="sig-ja" name="ja" rows={6} defaultValue={signatures.ja} />
            </div>
            <div>
              <label htmlFor="sig-en">英語（日本語以外のメールに使う）</label>
              <textarea id="sig-en" name="en" rows={6} defaultValue={signatures.en} />
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
                <label htmlFor="sig-addr">アドレス</label>
                <input id="sig-addr" name="overrideAddress" placeholder="wholesale@yusando.com" />
              </div>
              <div className="grid2">
                <textarea name="overrideJa" aria-label="このアドレスの日本語の署名" rows={5} placeholder="日本語の署名（空で削除）" />
                <textarea name="overrideEn" aria-label="このアドレスの英語の署名" rows={5} placeholder="英語の署名（空で削除）" />
              </div>
            </div>
          </details>
          <SubmitButton>保存</SubmitButton>
        </form>
      </section>

      <section className="panel" aria-labelledby="calendar">
        <h2 id="calendar">カレンダーと営業時間</h2>
        <form action={saveCalendarMapAction} className="stack">
          <p className="meta">予定の種類ごとに、登録先のカレンダーを選びます。</p>
          <div className="grid2">
            {DATE_KINDS.map((k) => (
              <div key={k}>
                <label htmlFor={`calmap-${k}`}>{DATE_KIND_LABELS[k]}</label>
                <select id={`calmap-${k}`} name={k} defaultValue={calendarMap[k]}>
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
          <div className="checks checks-week">
            {WEEK.map((w, i) => (
              <label key={i} className="inline">
                <input type="checkbox" name="days" value={i} defaultChecked={hours.days.includes(i)} />
                {w}
              </label>
            ))}
          </div>
          <div className="inline-form">
            <div>
              <label htmlFor="hours-start">開始</label>
              <input id="hours-start" type="time" name="start" defaultValue={hours.start} />
            </div>
            <div>
              <label htmlFor="hours-end">終了</label>
              <input id="hours-end" type="time" name="end" defaultValue={hours.end} />
            </div>
            <div>
              <label htmlFor="hours-slot">1枠（分）</label>
              <input id="hours-slot" type="number" name="slotMinutes" defaultValue={hours.slotMinutes} min={15} step={15} />
            </div>
            <SubmitButton>保存</SubmitButton>
          </div>
        </form>
      </section>

      <section className="panel" aria-labelledby="freee">
        <h2 id="freee">freee 会計</h2>
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
                <label htmlFor="freee-company">送り先の事業所</label>
                <select id="freee-company" name="companyId" defaultValue={freee.companyId ?? undefined}>
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
            <a className="button primary" href="/api/freee/connect">
              freee と連携する
            </a>
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="notify">
        <h2 id="notify">通知</h2>
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
      </section>

      <section className="panel" aria-labelledby="playbooks">
        <h2 id="playbooks">下書きの書き方</h2>
        <div className="disclosures">
        <details>
          <summary>会社情報（全ての下書きで Claude に渡します）</summary>
          <form action={saveBusinessContextAction} className="stack">
            <textarea name="businessContext" aria-label="会社情報" rows={14} defaultValue={businessContext} />
            <SubmitButton>保存</SubmitButton>
          </form>
        </details>
        {CATEGORIES.map((c) => (
          <details key={c}>
            <summary>{CATEGORY_LABELS[c]}</summary>
            <form action={savePlaybookAction} className="stack">
              <input type="hidden" name="category" value={c} />
              <textarea name="guidance" aria-label={`${CATEGORY_LABELS[c]} の書き方`} rows={8} defaultValue={playbookMap.get(c) ?? ""} />
              <SubmitButton>保存</SubmitButton>
            </form>
          </details>
        ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="claude">
        <h2 id="claude">Claude の接続</h2>
        {claudeFailure ? (
          <div className="banner error">
            <span>分類に失敗しています：{claudeFailure}</span>
          </div>
        ) : (
          <p className="meta">
            {claudeHealth.lastOkAt ? `最後に分類できたのは ${formatJst(new Date(claudeHealth.lastOkAt))} です。` : "まだ記録がありません。"}
          </p>
        )}
        {claudeTest === "ok" ? <div className="notes">接続できました。下の「分類し直す」で、失敗していたメールを分類し直せます。</div> : null}
        <p className="meta">API キーを入れ替えたあとは、ここで確かめてください。</p>
        <form action={testClaudeAction}>
          <SubmitButton>接続をテストする</SubmitButton>
        </form>
        <h3 style={{ marginTop: 18 }}>返信下書きの調べもの</h3>
        <p className="meta">
          下書きを書く Claude は、必要に応じて次を調べてから書きます。Google カレンダー（予定・空き）：つながっています。Shopify（商品・価格・在庫・注文・規約）：
          {shopFromEnv() ? "設定済み" : "未設定（SHOPIFY_STORE_DOMAIN と SHOPIFY_ADMIN_TOKEN を Secret Manager に入れると使えます）"}
        </p>
        {shopifyTest ? (
          <div className={shopifyTest.startsWith("ok:") ? "notes" : "banner error"}>
            {shopifyTest.startsWith("ok:") ? `Shopify から読めました：${shopifyTest.slice(3)}` : `Shopify から読めませんでした：${shopifyTest.slice(3)}`}
          </div>
        ) : null}
        {shopFromEnv() ? (
          <form action={testShopifyAction}>
            <SubmitButton>Shopify をテストする</SubmitButton>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="backfill">
        <h2 id="backfill">過去のメールの取り込み</h2>
        {backfillQueued ? <div className="notes">{backfillQueued} 通を取り込みの順番待ちに入れました。新しく届くメールを優先して、5分ごとに少しずつ進みます。</div> : null}
        <p className="meta">あなたの受信箱にある過去のメールを、さかのぼって分類します（下書きは自動では作りません）。</p>
        <form action={backfillAction} className="inline-form">
          <div>
            <label htmlFor="backfill-days">何日分</label>
            <input id="backfill-days" type="number" name="days" defaultValue={30} min={1} max={365} />
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
      </section>

      <section className="panel" aria-labelledby="audit">
        <h2 id="audit">操作の記録</h2>
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
            {!logs.length ? (
              <tr>
                <td className="meta">まだありません</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
