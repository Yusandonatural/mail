import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { settings } from "./db/schema";
import {
  DEFAULT_AUTO_DRAFT,
  DEFAULT_BUSINESS_CONTEXT,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_CALENDAR_MAP,
  DEFAULT_SIGNATURES,
  DEFAULT_FREEE,
  DEFAULT_NOTIFY,
  type FreeeSetting,
  type NotifySetting,
  type AutoDraftMap,
  type BusinessHours,
  type CalendarMap,
  type Signatures,
} from "./db/seed";

/** Claude（分類）の呼び出し結果。失敗が続いていれば画面の上に知らせる */
export interface ClaudeHealth {
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
}

interface SettingTypes {
  signatures: Signatures;
  businessHours: BusinessHours;
  calendarMap: CalendarMap;
  autoDraft: AutoDraftMap;
  businessContext: string;
  freee: FreeeSetting;
  notify: NotifySetting;
  claudeHealth: ClaudeHealth;
}

const DEFAULTS: SettingTypes = {
  signatures: DEFAULT_SIGNATURES,
  businessHours: DEFAULT_BUSINESS_HOURS,
  calendarMap: DEFAULT_CALENDAR_MAP,
  autoDraft: DEFAULT_AUTO_DRAFT,
  businessContext: DEFAULT_BUSINESS_CONTEXT,
  freee: DEFAULT_FREEE,
  notify: DEFAULT_NOTIFY,
  claudeHealth: { lastError: null, lastErrorAt: null, lastOkAt: null },
};

export type SettingKey = keyof SettingTypes;

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingTypes[K]> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  const row = rows[0];
  if (!row) return DEFAULTS[key];
  const fallback = DEFAULTS[key];
  if (typeof fallback === "object" && fallback !== null && typeof row.value === "object") {
    return { ...fallback, ...(row.value as object) } as SettingTypes[K];
  }
  return row.value as SettingTypes[K];
}

export async function putSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingTypes[K],
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/** 最後に分類に失敗してから、まだ一度も成功していなければ失敗の理由を返す */
export function claudeFailing(h: ClaudeHealth): string | null {
  if (!h.lastErrorAt || !h.lastError) return null;
  if (h.lastOkAt && h.lastOkAt >= h.lastErrorAt) return null;
  return h.lastError;
}

/** 分類の成否を記録する。成功は、直前が失敗だったときだけ書き込む（毎回は書かない） */
export async function recordClaudeResult(db: Db, error: string | null, now = new Date()): Promise<void> {
  const h = await getSetting(db, "claudeHealth");
  if (error) await putSetting(db, "claudeHealth", { ...h, lastError: error, lastErrorAt: now.toISOString() });
  else if (claudeFailing(h) || !h.lastOkAt) await putSetting(db, "claudeHealth", { ...h, lastOkAt: now.toISOString() });
}
