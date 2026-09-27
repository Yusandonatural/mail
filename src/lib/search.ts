import { folderLabelName, isFolder } from "./domain";

/** Gmail の検索（演算子もそのまま使える）＋ フォルダ・期間の絞り込み（仕様書 3章） */
export function buildQuery(q: string, folder: string | null, after: string, before: string): string {
  const parts = [q.trim()];
  if (folder && isFolder(folder)) parts.push(`label:"${folderLabelName(folder)}"`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(after)) parts.push(`after:${after.replace(/-/g, "/")}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(before)) parts.push(`before:${before.replace(/-/g, "/")}`);
  return parts.filter(Boolean).join(" ");
}
