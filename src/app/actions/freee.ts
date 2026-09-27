"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canSeeFolder } from "@/lib/access";
import { disconnectFreee, freeeApiFor } from "@/lib/freee";
import { sendAttachmentToFreee } from "@/lib/freee-service";
import { getSetting, putSetting } from "@/lib/settings";
import { mailFor } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { errorResult, ownMessage, type ActionResult } from "./common";

export async function sendToFreeeAction(rowId: number, partId: string): Promise<ActionResult<{ receiptId: string; already: boolean }>> {
  try {
    const { user, row } = await ownMessage(rowId);
    if (!canSeeFolder(user, "keiri")) return { ok: false, error: "経理フォルダを見られる人だけが freee に送れます" };
    const db = await getDb();
    const r = await sendAttachmentToFreee({ db, mail: mailFor(user), freee: freeeApiFor(db) }, user, row, partId);
    if (r.kind === "uploaded") await audit(db, user.id, "freee_uploaded", row.gmailMessageId, { receiptId: r.receiptId, partId });
    revalidatePath(`/m/${row.id}`);
    return { ok: true, data: { receiptId: r.receiptId, already: r.kind === "already" } };
  } catch (err) {
    return errorResult(err);
  }
}

export async function selectFreeeCompanyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  const s = await getSetting(db, "freee");
  const id = Number(formData.get("companyId"));
  const company = s.companies.find((c) => c.id === id);
  if (!company) throw new Error("事業所が見つかりません");
  await putSetting(db, "freee", { ...s, companyId: company.id, companyName: company.name });
  await audit(db, admin.id, "settings_changed", "freee", { companyId: company.id });
  revalidatePath("/settings");
}

export async function disconnectFreeeAction(): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  await disconnectFreee(db);
  await audit(db, admin.id, "settings_changed", "freee", { connected: false });
  revalidatePath("/settings");
}
