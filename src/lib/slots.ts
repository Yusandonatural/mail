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
