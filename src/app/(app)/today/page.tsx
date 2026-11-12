import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { dateCandidates, messages } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { canSeeMessage } from "@/lib/access";
import { upcomingDues } from "@/lib/queries";
import { calendarFor } from "@/lib/services";
import { eventsForDays, TENTATIVE_PREFIX } from "@/lib/calendar-service";
import type { CalendarEvent } from "@/lib/google/calendar-api";
import { addDays, formatJst, jstDateString, parseDateish } from "@/lib/time";
import { formatAmount } from "@/components/message-row";

/** 今日・今週の予定と、予定に紐付くメール、近い支払期日（仕様書 6章・8章） */
export default async function TodayPage() {
  const user = await requireUser();
  const db = await getDb();
  const now = new Date();
  let events: CalendarEvent[] = [];
  let error: string | null = null;
  try {
    events = await eventsForDays(db, calendarFor(user), now, 7);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const linked = events.length
    ? await db
        .select({ c: dateCandidates, m: messages })
        .from(dateCandidates)
        .innerJoin(
          messages,
          and(eq(messages.userId, dateCandidates.userId), eq(messages.gmailMessageId, dateCandidates.gmailMessageId)),
        )
        .where(
          and(
            eq(dateCandidates.userId, user.id),
            inArray(
              dateCandidates.calendarEventId,
              events.map((e) => e.id),
            ),
          ),
        )
    : [];
  const byEvent = new Map(linked.filter((l) => canSeeMessage(user, l.m)).map((l) => [l.c.calendarEventId, l.m]));

  const today = jstDateString(now);
  const in14 = jstDateString(addDays(now, 14));
  const dues = await upcomingDues(db, user, today, in14);

  const days = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const key = e.allDay ? e.start.slice(0, 10) : jstDateString(new Date(e.start));
    days.set(key, [...(days.get(key) ?? []), e]);
  }

  const daysLeft = (due: string) => {
    const d = parseDateish(due);
    if (!d) return "";
    const n = Math.round((d.getTime() - (parseDateish(today) ?? now).getTime()) / 86_400_000);
    return n <= 0 ? "今日" : n === 1 ? "明日" : `あと${n}日`;
  };

  return (
    <div className="narrow">
      <div className="topbar">
        <h1>今日・今週の予定</h1>
      </div>
      {error ? (
        <div className="banner error" role="alert">
          <span>カレンダーを読み込めませんでした：{error}</span>
        </div>
      ) : null}
      {dues.length ? (
        <section className="panel" aria-labelledby="dues-head">
          <h2 id="dues-head">
            14日以内の支払期日
            <span className="meta">{dues.length}件</span>
          </h2>
          <ul className="day-list">
            {dues.map((m) => {
              const left = m.dueDate ? daysLeft(m.dueDate) : "";
              return (
                <li key={m.id} className="day-item">
                  <span className="day-time">
                    {m.dueDate ? formatJst(parseDateish(m.dueDate) ?? now, false) : ""}
                    {left ? <span className={left === "今日" || left === "明日" ? "due-left soon" : "due-left"}>{left}</span> : null}
                  </span>
                  <span className="day-main">
                    <Link href={`/m/${m.id}`} className="day-title">
                      {m.fromName || m.fromEmail}
                    </Link>
                    {m.summary ? <span className="meta">{m.summary}</span> : null}
                  </span>
                  <span className="amount">{formatAmount(m.amount, m.currency)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {[...days.entries()].map(([day, list]) => (
        <section key={day} className={day === today ? "panel is-today" : "panel"} aria-label={formatJst(parseDateish(day) ?? now, false)}>
          <h2>
            <span className="day-head">
              {formatJst(parseDateish(day) ?? now, false)}
              {day === today ? <span className="badge date">今日</span> : null}
            </span>
            <span className="meta">{list.length}件</span>
          </h2>
          <ul className="day-list">
            {list.map((e) => {
              const m = byEvent.get(e.id);
              const tentative = e.summary.startsWith(TENTATIVE_PREFIX);
              const title = tentative ? e.summary.slice(TENTATIVE_PREFIX.length) : e.summary;
              return (
                <li key={e.id} className="day-item">
                  <span className="day-time">{e.allDay ? "終日" : formatJst(new Date(e.start)).split(" ")[1]}</span>
                  <span className="day-main">
                    <span className="day-title-row">
                      {e.htmlLink ? (
                        <a href={e.htmlLink} target="_blank" rel="noreferrer" className="day-title">
                          {title}
                        </a>
                      ) : (
                        <span className="day-title">{title}</span>
                      )}
                      {tentative ? <span className="badge review">仮</span> : null}
                    </span>
                    {m ? (
                      <span className="meta">
                        元メール：<Link href={`/m/${m.id}`}>{m.subject || "(件名なし)"}</Link>
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {!error && !events.length ? <div className="panel empty">今週の予定はありません</div> : null}
    </div>
  );
}
