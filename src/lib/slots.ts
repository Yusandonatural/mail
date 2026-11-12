import type { BusinessHours } from "./db/seed";
import type { Interval } from "./google/calendar-api";
import { addDays, fromJst, hmToMinutes, jstParts, startOfJstDay } from "./time";

export interface SlotRequest {
  busy: Interval[];
  hours: BusinessHours;
  from: Date;
  /** 何日先まで探すか */
  days: number;
  durationMinutes: number;
  count: number;
  /** 今から何時間以内は候補にしない */
  leadHours?: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 営業時間とカレンダーの予定から空き時間の候補を作る（仕様書 6章「候補を3つ提案」）。
 * 相手が選びやすいよう、1日に1枠ずつ、別々の日から選ぶ。
 */
export function proposeSlots(req: SlotRequest): Interval[] {
  const lead = new Date(req.from.getTime() + (req.leadHours ?? 24) * 3600 * 1000);
  const startMin = hmToMinutes(req.hours.start);
  const endMin = hmToMinutes(req.hours.end);
  const step = Math.max(15, req.hours.slotMinutes);
  const result: Interval[] = [];
  let day = startOfJstDay(req.from);
  for (let i = 0; i <= req.days && result.length < req.count; i++, day = addDays(day, 1)) {
    const p = jstParts(day);
    if (!req.hours.days.includes(p.weekday)) continue;
    for (let m = startMin; m + req.durationMinutes <= endMin; m += step) {
      const start = fromJst(p.year, p.month, p.day, Math.floor(m / 60), m % 60);
      const slot = { start, end: new Date(start.getTime() + req.durationMinutes * 60000) };
      if (slot.start < lead) continue;
      if (req.busy.some((b) => overlaps(slot, b))) continue;
      result.push(slot);
      break;
    }
  }
  return result;
}

/** 1日の営業時間から予定の入っている時間を除いた空き（短すぎる隙間は除く） */
export function freeWindows(busy: Interval[], hours: BusinessHours, day: Date, minMinutes = 30): Interval[] {
  const p = jstParts(day);
  if (!hours.days.includes(p.weekday)) return [];
  const s = hmToMinutes(hours.start);
  const e = hmToMinutes(hours.end);
  const open = fromJst(p.year, p.month, p.day, Math.floor(s / 60), s % 60);
  const close = fromJst(p.year, p.month, p.day, Math.floor(e / 60), e % 60);
  const blocks = busy
    .filter((b) => b.start < close && b.end > open)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const result: Interval[] = [];
  let cursor = open;
  for (const b of blocks) {
    if (b.start > cursor) result.push({ start: cursor, end: b.start < close ? b.start : close });
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < close) result.push({ start: cursor, end: close });
  return result.filter((w) => w.end.getTime() - w.start.getTime() >= minMinutes * 60000);
}
