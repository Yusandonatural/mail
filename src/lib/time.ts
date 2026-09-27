/**
 * 日本時間（UTC+9、夏時間なし）の扱い。サーバーのタイムゾーンに依存しないよう固定オフセットで計算する。
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date → 日本時間の各要素 */
export function jstParts(d: Date) {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
    weekday: j.getUTCDay(),
  };
}

/** 日本時間の年月日時分 → Date */
export function fromJst(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS);
}

export function startOfJstDay(d: Date): Date {
  const p = jstParts(d);
  return fromJst(p.year, p.month, p.day);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function jstDateString(d: Date): string {
  const p = jstParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 2026-10-03T14:00:00+09:00 形式 */
export function jstIso(d: Date): string {
  const p = jstParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00+09:00`;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 10月3日(土) 14:00 */
export function formatJst(d: Date, withTime = true): string {
  const p = jstParts(d);
  const date = `${p.month}月${p.day}日(${WEEKDAYS[p.weekday]})`;
  return withTime ? `${date} ${p.hour}:${pad(p.minute)}` : date;
}

/** "09:30" → 分 */
export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** "YYYY-MM-DD" または ISO 文字列を Date に。日付だけなら日本時間の 0 時 */
export function parseDateish(value: string): Date | null {
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return fromJst(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  // タイムゾーンの無い日時は日本時間とみなす
  const naive = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/);
  if (naive) {
    return fromJst(Number(naive[1]), Number(naive[2]), Number(naive[3]), Number(naive[4]), Number(naive[5]));
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
