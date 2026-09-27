import { describe, expect, it } from "vitest";
import { proposeSlots } from "@/lib/slots";
import { fromJst, jstParts, parseDateish } from "@/lib/time";

const hours = { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00", slotMinutes: 60 };

describe("空き時間の候補", () => {
  it("営業日の営業時間内から、別々の日に3つ出す", () => {
    // 2026-09-27 は日曜
    const from = fromJst(2026, 9, 27, 10, 0);
    const slots = proposeSlots({ busy: [], hours, from, days: 14, durationMinutes: 60, count: 3 });
    expect(slots).toHaveLength(3);
    const days = slots.map((s) => jstParts(s.start));
    expect(days.map((d) => d.day)).toEqual([28, 29, 30]);
    // 月曜は「今から24時間以内は除く」ので 10 時から
    expect(days.map((d) => d.hour)).toEqual([10, 9, 9]);
    expect(days.every((d) => d.weekday !== 0)).toBe(true);
  });

  it("予定と重なる時間は避ける", () => {
    const from = fromJst(2026, 9, 27, 10, 0);
    const busy = [{ start: fromJst(2026, 9, 28, 8, 0), end: fromJst(2026, 9, 28, 12, 30) }];
    const [first] = proposeSlots({ busy, hours, from, days: 14, durationMinutes: 60, count: 1 });
    expect(jstParts(first.start)).toMatchObject({ day: 28, hour: 13 });
  });

  it("24時間以内は候補にしない", () => {
    const from = fromJst(2026, 9, 28, 8, 0);
    const [first] = proposeSlots({ busy: [], hours, from, days: 14, durationMinutes: 60, count: 1 });
    expect(jstParts(first.start)).toMatchObject({ day: 29, hour: 9 });
  });
});

describe("日時の読み取り", () => {
  it("タイムゾーンの無い日時は日本時間とみなす", () => {
    expect(parseDateish("2026-10-03T14:00")?.toISOString()).toBe("2026-10-03T05:00:00.000Z");
    expect(parseDateish("2026-10-03")?.toISOString()).toBe("2026-10-02T15:00:00.000Z");
    expect(parseDateish("2026-10-03T14:00:00+09:00")?.toISOString()).toBe("2026-10-03T05:00:00.000Z");
    expect(parseDateish("来週")).toBeNull();
  });
});
