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

interface SettingTypes {
  signatures: Signatures;
  businessHours: BusinessHours;
  calendarMap: CalendarMap;
  autoDraft: AutoDraftMap;
  businessContext: string;
  freee: FreeeSetting;
  notify: NotifySetting;
}

const DEFAULTS: SettingTypes = {
  signatures: DEFAULT_SIGNATURES,
  businessHours: DEFAULT_BUSINESS_HOURS,
  calendarMap: DEFAULT_CALENDAR_MAP,
  autoDraft: DEFAULT_AUTO_DRAFT,
  businessContext: DEFAULT_BUSINESS_CONTEXT,
  freee: DEFAULT_FREEE,
  notify: DEFAULT_NOTIFY,
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
