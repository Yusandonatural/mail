"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { addressMap, playbooks, rules, users } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { DATE_KINDS, FOLDER_KEYS, isCategory, isFolder, type Folder } from "@/lib/domain";
import { putSetting, getSetting } from "@/lib/settings";
import type { CalendarMap } from "@/lib/db/seed";
import { requireAdmin } from "@/lib/session";
import { mailFor } from "@/lib/services";
import { backfill } from "@/lib/sync";

const done = () => revalidatePath("/settings");

export async function saveAddressAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const address = String(formData.get("address") ?? "").trim().toLowerCase();
  const folder = String(formData.get("folder"));
  if (!address.includes("@") || !isFolder(folder)) throw new Error("アドレスかフォルダが正しくありません");
  const values = {
    folder,
    contentDecides: formData.get("contentDecides") === "on",
    note: String(formData.get("note") ?? ""),
  };
  const db = await getDb();
  await db
    .insert(addressMap)
    .values({ address, ...values })
    .onConflictDoUpdate({ target: addressMap.address, set: values });
  await audit(db, admin.id, "settings_changed", `address:${address}`, values);
  done();
}

export async function deleteAddressAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const address = String(formData.get("address"));
  const db = await getDb();
  await db.delete(addressMap).where(eq(addressMap.address, address));
  await audit(db, admin.id, "settings_changed", `address:${address}`, { deleted: true });
  done();
}

export async function saveRuleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const kind = String(formData.get("kind"));
  const pattern = String(formData.get("pattern") ?? "").trim().toLowerCase().replace(/^@/, "");
  const folder = String(formData.get("folder"));
  if (!["sender", "domain"].includes(kind) || !pattern || !isFolder(folder)) throw new Error("ルールが正しくありません");
  const db = await getDb();
  await db
    .insert(rules)
    .values({ kind, pattern, folder, createdBy: admin.id })
    .onConflictDoUpdate({ target: [rules.kind, rules.pattern], set: { folder } });
  await audit(db, admin.id, "rule_created", pattern, { kind, folder });
  done();
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = Number(formData.get("id"));
  const db = await getDb();
  await db.delete(rules).where(eq(rules.id, id));
  await audit(db, admin.id, "rule_deleted", String(id));
  done();
}

export async function savePlaybookAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const category = String(formData.get("category"));
  if (!isCategory(category)) throw new Error("カテゴリが正しくありません");
  const guidance = String(formData.get("guidance") ?? "");
  const db = await getDb();
  await db
    .insert(playbooks)
    .values({ category, guidance })
    .onConflictDoUpdate({ target: playbooks.category, set: { guidance, updatedAt: new Date() } });
  await audit(db, admin.id, "settings_changed", `playbook:${category}`);
  done();
}

export async function saveSignaturesAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  const current = await getSetting(db, "signatures");
  const byAddress = { ...current.byAddress };
  const addr = String(formData.get("overrideAddress") ?? "").trim().toLowerCase();
  if (addr) {
    const ja = String(formData.get("overrideJa") ?? "");
    const en = String(formData.get("overrideEn") ?? "");
    if (ja || en) byAddress[addr] = { ...(ja ? { ja } : {}), ...(en ? { en } : {}) };
    else delete byAddress[addr];
  }
  await putSetting(db, "signatures", {
    ja: String(formData.get("ja") ?? current.ja),
    en: String(formData.get("en") ?? current.en),
    byAddress,
  });
  await audit(db, admin.id, "settings_changed", "signatures");
  done();
}

export async function saveCalendarMapAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  const map = Object.fromEntries(
    DATE_KINDS.map((k) => [k, String(formData.get(k) ?? "primary") || "primary"]),
  ) as CalendarMap;
  await putSetting(db, "calendarMap", map);
  await audit(db, admin.id, "settings_changed", "calendarMap", map);
  done();
}

export async function saveBusinessHoursAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  const value = {
    days: formData.getAll("days").map(Number).filter((n) => n >= 0 && n <= 6),
    start: String(formData.get("start") ?? "09:00"),
    end: String(formData.get("end") ?? "17:00"),
    slotMinutes: Math.max(15, Number(formData.get("slotMinutes") ?? 60)),
  };
  await putSetting(db, "businessHours", value);
  await audit(db, admin.id, "settings_changed", "businessHours", value);
  done();
}

export async function saveAutoDraftAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  const value = Object.fromEntries(FOLDER_KEYS.map((f) => [f, formData.get(f) === "on"])) as Record<Folder, boolean>;
  await putSetting(db, "autoDraft", value);
  await audit(db, admin.id, "settings_changed", "autoDraft", value);
  done();
}

export async function saveBusinessContextAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  await putSetting(db, "businessContext", String(formData.get("businessContext") ?? ""));
  await audit(db, admin.id, "settings_changed", "businessContext");
  done();
}

export async function saveUserAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("メールアドレスが正しくありません");
  const role = formData.get("role") === "admin" ? "admin" : "staff";
  const visible = formData.getAll("visibleFolders").map(String).filter(isFolder);
  const active = formData.get("active") !== "off";
  if (email === admin.email && (role !== "admin" || !active)) throw new Error("自分の管理者権限は外せません");
  const db = await getDb();
  await db
    .insert(users)
    .values({ email, role, visibleFolders: visible, active })
    .onConflictDoUpdate({ target: users.email, set: { role, visibleFolders: visible, active } });
  await audit(db, admin.id, "user_changed", email, { role, visible, active });
  done();
}

export async function backfillAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const days = Math.min(365, Math.max(1, Number(formData.get("days") ?? 7)));
  const db = await getDb();
  const n = await backfill(db, mailFor(admin), admin, days);
  await audit(db, admin.id, "backfill", `${days}d`, { queued: n });
  done();
}
