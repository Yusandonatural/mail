import { FOLDER_KEYS, type Folder } from "./domain";
import type { MessageRow, User } from "./db/schema";

/** 利用者が見られるフォルダ（仕様書 11章：経理は既定で管理者と経理担当のみ） */
export function visibleFolders(user: Pick<User, "role" | "visibleFolders">): Folder[] {
  if (user.role === "admin") return FOLDER_KEYS;
  return FOLDER_KEYS.filter((f) => user.visibleFolders.includes(f));
}

export function canSeeFolder(user: Pick<User, "role" | "visibleFolders">, folder: string): boolean {
  return visibleFolders(user).includes(folder as Folder);
}

export function canSeeMessage(
  user: Pick<User, "role" | "visibleFolders">,
  row: Pick<MessageRow, "folder" | "secondaryFolders">,
): boolean {
  return [row.folder, ...row.secondaryFolders].some((f) => canSeeFolder(user, f));
}

export function isAdmin(user: Pick<User, "role">): boolean {
  return user.role === "admin";
}
