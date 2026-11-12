import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { contacts, drafts, messages, rules } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { canSeeMessage, isAdmin, visibleFolders } from "@/lib/access";
import {
  CATEGORY_LABELS,
  DATE_KIND_LABELS,
  folderName,
  isCategory,
  isFolder,
  ruleTargetName,
  LANGUAGE_LABELS,
  type DateKind,
  type Language,
} from "@/lib/domain";
import { calendarFor, mailFor } from "@/lib/services";
import { parseMessage, type ParsedMessage } from "@/lib/mail/parse";
import { hiddenInThread, safeBack, threadCandidates, threadDrafts } from "@/lib/queries";
import { defaultEdits, eventsForDays, gmailThreadLink } from "@/lib/calendar-service";
import { formatJst, jstIso, parseDateish } from "@/lib/time";
import { adoptGmailDrafts, draftText } from "@/lib/drafts";
import type { CalendarApi, CalendarEvent, CalendarInfo } from "@/lib/google/calendar-api";
import type { MailApi } from "@/lib/google/mail-api";
import { HtmlFrame } from "@/components/html-frame";
import { DraftCreate, DraftEditor, type DraftView } from "@/components/draft-editor";
import { SubmitButton } from "@/components/submit-button";
import { Avatar, formatAmount } from "@/components/message-row";
import { FreeePanel } from "@/components/freee-panel";
import { MarkRead } from "@/components/mark-read";
import { Translation } from "@/components/translation";
import { isMostlyJapanese } from "@/lib/translate";
import { stripQuoted } from "@/lib/mail/parse";
import { canSeeFolder } from "@/lib/access";
import { FREEE_RECEIPT_TYPES } from "@/lib/freee";
import { uploadKey, uploadsFor } from "@/lib/freee-service";
import { getSetting } from "@/lib/settings";
import { archiveAction, markReviewed, moveFolder, saveContactAction } from "@/app/actions/mail";
import { confirmEventAction, createEventAction, ignoreCandidateAction } from "@/app/actions/calendar";

function toLocalInput(value: string | null, allDay: boolean): string {
  if (!value) return "";
  if (allDay) return value.slice(0, 10);
  const d = parseDateish(value);
  return d ? jstIso(d).slice(0, 16) : "";
}

export default async function MessagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ images?: string; back?: string }>;
}) {
  const { id } = await params;
  const { images, back: backParam } = await searchParams;
  if (!/^\d{1,9}$/.test(id)) notFound();
  const user = await requireUser();
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, Number(id)), eq(messages.userId, user.id)))
      .limit(1)
  )[0];
  if (!row || !canSeeMessage(user, row)) notFound();
  const back = safeBack(backParam);
  const self = `/m/${row.id}?back=${encodeURIComponent(back)}`;

  let thread: ParsedMessage[] = [];
  let loadError: string | null = null;
  let mail: MailApi | null = null;
  let calendar: CalendarApi | null = null;
  try {
    mail = mailFor(user);
    calendar = calendarFor(user);
    const all = ((await mail.getThread(row.gmailThreadId)).messages ?? []).map(parseMessage);
    // 同じスレッドでも、見られないフォルダ（経理など）に分類されたメールは出さない
    const hidden = await hiddenInThread(db, user, row.gmailThreadId);
    thread = all.filter((m) => !m.labelIds.includes("DRAFT") && !hidden.has(m.id));
    // Claude のスキルや Gmail の画面で作った下書きがあれば、下書き欄に出せるよう取り込む
    if (all.some((m) => m.labelIds.includes("DRAFT"))) {
      await adoptGmailDrafts(db, mail, user, row.gmailThreadId).catch((e) => console.error("adopt drafts failed", e));
    }
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }


  // 下書き（Gmail から本文を読む。Gmail 側で消えたものは閉じる。読めないときは触らない）
  const draftViews: DraftView[] = [];
  const draftRows = mail && !loadError ? await threadDrafts(db, user.id, row.gmailThreadId) : [];
  // 別案が複数あっても待ち時間が増えないよう、Gmail からは並行して読む
  const gmailDrafts = await Promise.all(draftRows.map((d) => mail!.getDraft(d.gmailDraftId).catch(() => undefined)));
  for (const [i, d] of draftRows.entries()) {
    const g = gmailDrafts[i];
    if (g === undefined) continue;
    if (!g) {
      await db.update(drafts).set({ status: "discarded" }).where(eq(drafts.id, d.id));
      continue;
    }
    draftViews.push({
      id: d.id,
      gmailDraftId: d.gmailDraftId,
      gmailMessageId: g.message.id ?? "",
      text: draftText(parseMessage(g.message)),
      notes: d.notes,
      version: d.version,
      instruction: d.instruction,
    });
  }

  const candidates = (await threadCandidates(db, user.id, row.gmailThreadId)).filter((c) => c.status !== "ignored");
  let calendars: CalendarInfo[] = [];
  const agendas = new Map<string, CalendarEvent[]>();
  if (candidates.length && calendar) {
    const cal = calendar;
    const days = [...new Set(candidates.filter((c) => c.status === "candidate").map((c) => c.start.slice(0, 10)))].slice(0, 3);
    // カレンダーの一覧と各日の予定は、Google から並行して読む
    const [list, perDay] = await Promise.all([
      cal.listCalendars().catch(() => []),
      Promise.all(
        days.map((day) => {
          const d = parseDateish(day);
          return d ? eventsForDays(db, cal, d, 1).catch(() => []) : null;
        }),
      ),
    ]);
    calendars = list;
    days.forEach((day, i) => {
      const events = perDay[i];
      if (events) agendas.set(day, events);
    });
  }
  const edits = await Promise.all(candidates.map((c) => defaultEdits(db, c)));

  const contact = (await db.select().from(contacts).where(eq(contacts.email, row.fromEmail)).limit(1))[0];
  const domain = row.fromEmail.slice(row.fromEmail.indexOf("@") + 1);
  const senderRules = (await db.select().from(rules)).filter(
    (r) => (r.kind === "sender" && r.pattern === row.fromEmail) || (r.kind === "domain" && (domain === r.pattern || domain.endsWith(`.${r.pattern}`))),
  );

  // freee：経理のメールで、PDF か画像の添付があり、freee と連携しているとき
  const freeeSetting = await getSetting(db, "freee");
  const target = thread.find((m) => m.id === row.gmailMessageId);
  const receiptFiles = (target?.attachments ?? []).filter((a) => FREEE_RECEIPT_TYPES.has(a.mimeType));
  const showFreee =
    Boolean(freeeSetting.refreshTokenEnc && freeeSetting.companyId) &&
    canSeeFolder(user, "keiri") &&
    (row.folder === "keiri" || row.secondaryFolders.includes("keiri")) &&
    receiptFiles.length > 0;
  const sent = showFreee ? new Map((await uploadsFor(db, row)).map((u) => [u.dedupeKey, u.receiptId])) : new Map();

  // 一覧はスレッドで1行なので、スレッドのどれかが未読なら開いた時点でまとめて既読にする
  const threadUnread =
    row.unread ||
    (
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.userId, user.id), eq(messages.gmailThreadId, row.gmailThreadId), eq(messages.unread, true)))
        .limit(1)
    ).length > 0;
  const category = row.category && isCategory(row.category) ? CATEGORY_LABELS[row.category] : null;
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";

  return (
    <>
      {threadUnread ? <MarkRead rowId={row.id} /> : null}
      <div className="topbar">
        <Link href={back} data-back>
          ← 一覧に戻る
        </Link>
        <div className="actions detail-actions">
          <Link className="button" href={`/compose?forward=${row.id}`}>
            転送
          </Link>
          <form action={archiveAction}>
            <input type="hidden" name="rowId" value={row.id} />
            <input type="hidden" name="kind" value="archive" />
            <input type="hidden" name="back" value={back} />
            <SubmitButton data-archive>
              アーカイブ <span className="key" aria-hidden="true">e</span>
            </SubmitButton>
          </form>
          <form action={archiveAction} id={`spam-${row.id}`}>
            <input type="hidden" name="rowId" value={row.id} />
            <input type="hidden" name="kind" value="spam" />
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="danger" data-spam>
              迷惑メール <span className="key" aria-hidden="true">!</span>
            </SubmitButton>
          </form>
          <form action={archiveAction}>
            <input type="hidden" name="rowId" value={row.id} />
            <input type="hidden" name="kind" value="trash" />
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="danger" data-trash>
              削除 <span className="key" aria-hidden="true">#</span>
            </SubmitButton>
          </form>
          {/* 迷惑メールのボタンと一緒に送る（form 属性で上の form に属させる） */}
          <label className="meta block-opt" title={`${row.fromEmail} から今後届くメールも、自動で迷惑メールへ移します`}>
            <input type="checkbox" name="block" value="1" form={`spam-${row.id}`} /> 迷惑メールにするとき、今後もこの送信者を迷惑メールへ
          </label>
        </div>
      </div>

      {row.needsReview ? (
        <div className="banner review">
          <strong>要確認</strong>
          <span>
            {row.source === "content"
              ? "宛先と内容の判定が食い違ったため、内容で振り分けました。"
              : "分類の自信が低いメールです。"}
            このフォルダでよいですか？
          </span>
          <form action={markReviewed}>
            <input type="hidden" name="rowId" value={row.id} />
            <SubmitButton>このままでよい</SubmitButton>
          </form>
        </div>
      ) : null}
      {row.suggestConfirm ? (
        <div className="banner confirm">
          相手が日程を承諾したようです。「日程」の欄で仮予定を確定にできます。
        </div>
      ) : null}
      {loadError ? (
        <div className="banner error" role="alert">
          <span>
            Gmail から読み込めませんでした：{loadError}。続く場合は一度ログアウトして、ログインし直してください。
          </span>
        </div>
      ) : null}

      <div className="detail">
        <div className="col-main">
          <div className="panel p-summary">
            <h1>{row.subject || "(件名なし)"}</h1>
            <div className="sender">
              <Avatar name={row.fromName || row.fromEmail} email={row.fromEmail} />
              <span className="sender-text">
                <strong>{row.fromName || row.fromEmail}</strong>
                <span className="meta">
                  {row.fromName ? `${row.fromEmail}・` : ""}
                  {formatJst(row.receivedAt)}
                </span>
              </span>
            </div>
            <div className="badges" style={{ marginBottom: 10 }}>
              {isFolder(row.folder) ? <span className="badge draft">{folderName(row.folder)}</span> : null}
              {row.secondaryFolders.filter(isFolder).map((f) => (
                <span key={f} className="badge">
                  {folderName(f)}
                </span>
              ))}
              {category && category !== (isFolder(row.folder) ? folderName(row.folder) : "") ? (
                <span className="badge">内容：{category}</span>
              ) : null}
              <span className="badge">{LANGUAGE_LABELS[row.language as Language] ?? row.language}</span>
              {row.urgency === "high" ? <span className="badge high">至急</span> : null}
              {row.amount !== null ? <span className="badge">{formatAmount(row.amount, row.currency)}</span> : null}
              {row.dueDate ? <span className="badge date">期限 {row.dueDate}</span> : null}
              {row.confidence !== null ? <span className="badge">確度 {Math.round(row.confidence * 100)}%</span> : null}
            </div>
            <div className="notes">{row.summary}</div>
            <details style={{ marginTop: 10 }}>
              <summary>振り分けを直す</summary>
              <form action={moveFolder} className="stack">
                <input type="hidden" name="rowId" value={row.id} />
                <div className="inline-form">
                  <div>
                    <label htmlFor={`folder-${row.id}`} className="visually-hidden">
                      移動先のフォルダ
                    </label>
                    <select id={`folder-${row.id}`} name="folder" defaultValue={row.folder}>
                      {visibleFolders(user).map((f) => (
                        <option key={f} value={f}>
                          {folderName(f)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <SubmitButton className="primary">移動</SubmitButton>
                </div>
                <div>
                  <label className="inline">
                    <input type="radio" name="remember" value="" defaultChecked /> このメールだけ
                  </label>
                  <label className="inline">
                    <input type="radio" name="remember" value="sender" /> 今後も {row.fromEmail} は
                  </label>
                  <label className="inline">
                    <input type="radio" name="remember" value="domain" /> 今後も @{domain} は
                  </label>
                </div>
              </form>
            </details>
          </div>

          <div className="panel p-thread">
            {loadError ? <p className="empty">本文を読み込めませんでした。下の「Gmail で開く」から読めます。</p> : null}
            {thread.length > 1 ? <p className="meta thread-note">新しいメールが上です（全{thread.length}通）。古いメールは押すと開きます</p> : null}
            {[...thread].reverse().map((m, i) => {
              const ours = m.labelIds.includes("SENT") || m.from?.email === user.email;
              // 一番新しいメールと、このメール自身は開いておく
              const open = i === 0 || m.id === row.gmailMessageId;
              return (
                <details key={m.id} className={ours ? "msg ours" : "msg"} open={open}>
                  <summary className="msg-head">
                    <span>
                      <strong>{m.from?.name || m.from?.email}</strong> {m.from?.name ? `<${m.from.email}>` : ""}
                      {ours ? <span className="badge">送信済み</span> : null}
                      <br />
                      <span className="msg-to">宛先：{[...m.to, ...m.cc].map((a) => a.email).join(", ")}</span>
                      <span className="msg-snippet">{(stripQuoted(m.text) || m.text).replace(/\s+/g, " ").slice(0, 90)}</span>
                    </span>
                    <span>{formatJst(m.date)}</span>
                  </summary>
                  {m.html ? <HtmlFrame html={m.html} showImages={images === "1"} /> : <pre>{m.text}</pre>}
                  {!isMostlyJapanese(stripQuoted(m.text) || m.text) ? (
                    <Translation rowId={row.id} gmailMessageId={m.id} />
                  ) : null}
                  {m.attachments.length ? (
                    <div className="attachments">
                      {m.attachments.map((a) => (
                        <span key={a.partId} className="actions">
                          <a className="button" href={`/api/attachments/${m.id}/${a.partId}`}>
                            📎 {a.filename}
                          </a>
                          {/^(image\/|application\/pdf)/.test(a.mimeType) ? (
                            <a href={`/api/attachments/${m.id}/${a.partId}?inline=1`} target="_blank" rel="noreferrer">
                              プレビュー
                            </a>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </details>
              );
            })}
            {thread.some((m) => m.html) && images !== "1" ? (
              <p className="meta">
                外部の画像は表示していません。<Link href={`${self}&images=1`}>画像を表示</Link>
              </p>
            ) : null}
            <p className="meta">
              <a href={gmailThreadLink(user.email, row.gmailThreadId)} target="_blank" rel="noreferrer">
                Gmail で開く
              </a>
            </p>
          </div>
        </div>

        <div className="col-side">
          <div className="p-reply">
            {loadError ? (
              <div className="panel stack">
                <h2>返信</h2>
                <p className="meta">Gmail から読み込めないため、返信の下書きを出せません。読み込めるようになってから開き直してください。</p>
              </div>
            ) : draftViews.length ? (
              draftViews.map((d, i) => (
                <DraftEditor
                  key={`${d.id}-${d.version}-${d.gmailMessageId}`}
                  draft={d}
                  rowId={row.id}
                  clientId={clientId}
                  userEmail={user.email}
                  label={draftViews.length > 1 ? (i === 0 ? "返信下書き（最新の案）" : `別案 ${i}`) : "返信下書き"}
                  replyLanguage={row.language === "ja" ? "en" : row.language}
                  backHref={back}
                />
              ))
            ) : (
              <DraftCreate rowId={row.id} />
            )}
          </div>

          {candidates.length ? (
            <div className="panel">
              <h2>日程</h2>
              {candidates.map((c, i) => {
                const e = edits[i];
                const day = c.start.slice(0, 10);
                const agenda = agendas.get(day);
                return (
                  <div key={c.id} className="cand">
                    <div className="actions" style={{ justifyContent: "space-between" }}>
                      <strong>{DATE_KIND_LABELS[c.kind as DateKind] ?? c.kind}</strong>
                      <span className="badge">
                        {c.status === "candidate" ? "候補" : c.status === "tentative" ? "仮予定" : "確定"}
                      </span>
                    </div>
                    {c.note ? <div className="meta">{c.note}</div> : null}
                    {c.status === "candidate" ? (
                      <>
                        {agenda ? (
                          <div className="agenda">
                            {day} の予定：
                            {agenda.length
                              ? agenda.map((ev) => `${ev.allDay ? "終日" : formatJst(new Date(ev.start)).split(" ")[1]} ${ev.summary}`).join("、")
                              : "なし"}
                          </div>
                        ) : null}
                        <form action={createEventAction} className="stack">
                          <input type="hidden" name="candidateId" value={c.id} />
                          <input type="hidden" name="back" value={self} />
                          <div>
                            <label htmlFor={`title-${c.id}`}>タイトル</label>
                            <input id={`title-${c.id}`} name="title" defaultValue={e.title} />
                          </div>
                          <div className="stack">
                            <div>
                              <label htmlFor={`start-${c.id}`}>開始</label>
                              <input
                                id={`start-${c.id}`}
                                name="start"
                                type={c.allDay ? "date" : "datetime-local"}
                                defaultValue={toLocalInput(c.start, c.allDay)}
                              />
                            </div>
                            <div>
                              <label htmlFor={`end-${c.id}`}>終了（空なら1時間）</label>
                              <input
                                id={`end-${c.id}`}
                                name="end"
                                type={c.allDay ? "date" : "datetime-local"}
                                defaultValue={toLocalInput(c.end, c.allDay)}
                              />
                            </div>
                          </div>
                          <div>
                            <label htmlFor={`cal-${c.id}`}>カレンダー</label>
                            <select id={`cal-${c.id}`} name="calendarId" defaultValue={e.calendarId}>
                              <option value="primary">メイン</option>
                              {calendars
                                .filter((cal) => !cal.primary)
                                .map((cal) => (
                                  <option key={cal.id} value={cal.id}>
                                    {cal.summary}
                                  </option>
                                ))}
                            </select>
                          </div>
                          <div>
                            <label className="inline">
                              <input type="checkbox" name="allDay" defaultChecked={c.allDay} /> 終日
                            </label>
                            <label className="inline">
                              <input type="checkbox" name="tentative" defaultChecked={e.tentative} /> 仮予定にする
                            </label>
                          </div>
                          <div className="actions">
                            <SubmitButton className="primary">予定を作る</SubmitButton>
                          </div>
                        </form>
                        <form action={ignoreCandidateAction} className="cand-foot">
                          <input type="hidden" name="candidateId" value={c.id} />
                          <input type="hidden" name="back" value={self} />
                          <SubmitButton className="link-button">この候補は使わない</SubmitButton>
                        </form>
                      </>
                    ) : (
                      <div className="stack">
                        <div>
                          {c.title}（{c.allDay ? c.start.slice(0, 10) : formatJst(parseDateish(c.start) ?? new Date())}）
                        </div>
                        {c.status === "tentative" ? (
                          <form action={confirmEventAction}>
                            <input type="hidden" name="candidateId" value={c.id} />
                            <input type="hidden" name="back" value={self} />
                            <SubmitButton className={row.suggestConfirm ? "primary" : undefined}>確定にする</SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {showFreee ? (
            <FreeePanel
              rowId={row.id}
              companyName={freeeSetting.companyName ?? ""}
              attachments={receiptFiles.map((a) => ({
                partId: a.partId,
                filename: a.filename,
                receiptId: sent.get(uploadKey(row, a.filename)) ?? null,
              }))}
            />
          ) : null}

          <div className="panel">
            <h2>連絡先</h2>
            <div className="meta">
              {row.fromName ? `${row.fromName} ` : ""}&lt;{row.fromEmail}&gt;
            </div>
            {/* 夜間の要約は、ほかの人の受信箱（見られないフォルダを含む）のメールから作られるので管理者にだけ出す */}
            {contact?.lastSummary && isAdmin(user) ? <div className="notes" style={{ marginTop: 8 }}>{contact.lastSummary}</div> : null}
            {senderRules.length ? (
              <div className="meta" style={{ marginTop: 8 }}>
                適用中の振り分けルール：
                {senderRules.map((r) => `${r.kind === "sender" ? r.pattern : `@${r.pattern}`} → ${ruleTargetName(r.folder)}`).join("、")}
              </div>
            ) : null}
            <form action={saveContactAction} className="stack" style={{ marginTop: 8 }}>
              <input type="hidden" name="email" value={row.fromEmail} />
              <input type="hidden" name="back" value={self} />
              <div className="grid2">
                <div>
                  <label htmlFor="contact-org">組織</label>
                  <input id="contact-org" name="organization" defaultValue={contact?.organization ?? ""} />
                </div>
                <div>
                  <label htmlFor="contact-rel">関係</label>
                  <input id="contact-rel" name="relationship" defaultValue={contact?.relationship ?? ""} placeholder="例：抹茶の卸先" />
                </div>
              </div>
              <div>
                <label htmlFor="contact-notes">メモ（下書きの参考になります）</label>
                <textarea id="contact-notes" name="notes" rows={3} defaultValue={contact?.notes ?? ""} />
              </div>
              <SubmitButton>メモを保存</SubmitButton>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
