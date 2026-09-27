import Link from "next/link";
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { dateCandidates, messages } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { canSeeMessage } from "@/lib/access";
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
  const dues = (
    await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.userId, user.id),
          isNotNull(messages.dueDate),
          gte(messages.dueDate, today),
          lte(messages.dueDate, in14),
        ),
      )
      .orderBy(messages.dueDate)
  ).filter((m) => canSeeMessage(user, m));

  const days = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const key = e.allDay ? e.start.slice(0, 10) : jstDateString(new Date(e.start));
    days.set(key, [...(days.get(key) ?? []), e]);
  }

  return (
    <>
      <div className="topbar">
        <h1>今日・今週の予定</h1>
      </div>
      {error ? <div className="banner error">カレンダーを読み込めませんでした：{error}</div> : null}
      {dues.length ? (
        <div className="panel">
          <h2>14日以内の支払期日</h2>
          <table className="simple">
            <tbody>
              {dues.map((m) => (
                <tr key={m.id}>
                  <td style={{ width: 110 }}>{m.dueDate}</td>
                  <td>
                    <Link href={`/m/${m.id}`}>{m.fromName || m.fromEmail}</Link>
                    <div className="meta">{m.summary}</div>
                  </td>
                  <td className="amount">{formatAmount(m.amount, m.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {[...days.entries()].map(([day, list]) => (
        <div key={day} className="panel">
          <h2>
            {formatJst(parseDateish(day) ?? now, false)}
            {day === today ? <span className="badge reply">今日</span> : null}
          </h2>
          <table className="simple">
            <tbody>
              {list.map((e) => {
                const m = byEvent.get(e.id);
                return (
                  <tr key={e.id}>
                    <td style={{ width: 90 }}>{e.allDay ? "終日" : formatJst(new Date(e.start)).split(" ")[1]}</td>
                    <td>
                      {e.htmlLink ? (
                        <a href={e.htmlLink} target="_blank" rel="noreferrer">
                          {e.summary}
                        </a>
                      ) : (
                        e.summary
                      )}
                      {e.summary.startsWith(TENTATIVE_PREFIX) ? <span className="badge reply">仮</span> : null}
                      {m ? (
                        <div className="meta">
                          元メール：<Link href={`/m/${m.id}`}>{m.subject}</Link>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {!error && !events.length ? <div className="panel empty">今週の予定はありません</div> : null}
    </>
  );
}
