import { folderLabelName, STATUS_LABELS, type Folder, type StatusLabelKey } from "./domain";
import type { MailApi } from "./google/mail-api";

/**
 * Gmail ラベル名 → ID の解決。無いラベルはその場で作る。
 * 「悠三堂/経理・支払・請求書」のような入れ子の名前は、親ラベルが無ければ先に作る。
 */
export class LabelResolver {
  private byName: Map<string, string> | null = null;

  constructor(private mail: MailApi) {}

  private async load(): Promise<Map<string, string>> {
    if (!this.byName) {
      const labels = await this.mail.listLabels();
      this.byName = new Map(labels.map((l) => [l.name, l.id]));
    }
    return this.byName;
  }

  async id(name: string): Promise<string> {
    const map = await this.load();
    const existing = map.get(name);
    if (existing) return existing;
    const slash = name.lastIndexOf("/");
    if (slash > 0) await this.id(name.slice(0, slash));
    try {
      const created = await this.mail.createLabel(name);
      map.set(created.name, created.id);
      return created.id;
    } catch (err) {
      // 別の処理が同時に同じラベルを作っていた（409）ときは、一覧を取り直してそれを使う
      const labels = await this.mail.listLabels();
      this.byName = new Map(labels.map((l) => [l.name, l.id]));
      const found = this.byName.get(name);
      if (found) return found;
      throw err;
    }
  }

  async folderId(folder: Folder): Promise<string> {
    return this.id(folderLabelName(folder));
  }

  async statusId(key: StatusLabelKey): Promise<string> {
    return this.id(STATUS_LABELS[key]);
  }

  /** 既に存在するときだけ ID を返す（外す操作のときに無駄に作らない） */
  async existingId(name: string): Promise<string | null> {
    return (await this.load()).get(name) ?? null;
  }
}
