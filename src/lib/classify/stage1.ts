import { BLOCK_RULE, PERSONAL_FOLDER_KEY, isFolder, type Folder } from "../domain";
import { listIdToAddress, type ParsedMessage } from "../mail/parse";

/**
 * 一次分類（仕様書 4章）：送信者ルール → 宛先アドレスの順で、機械的にフォルダを決める。
 */

export interface SenderRule {
  kind: "sender" | "domain";
  pattern: string;
  folder: string;
}

export interface AddressEntry {
  address: string;
  folder: string;
  contentDecides: boolean;
}

export type Stage1Source = "sender_rule" | "domain_rule" | "address" | "none";

export interface Stage1Result {
  folder: Folder | null;
  source: Stage1Source;
  /** 個人・総合窓口アドレス宛て。内容分類でフォルダを決め直す */
  contentDecides: boolean;
  /** Cc などで一緒に届いた他の用途別アドレスのフォルダ（副ラベル） */
  secondaryFolders: Folder[];
  /** マッチした用途別アドレス（返信の送信元の候補） */
  matchedAddress: string | null;
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function matchRule(
  fromEmail: string | undefined,
  rules: SenderRule[],
  accept: (target: string) => boolean,
): SenderRule | null {
  if (!fromEmail) return null;
  const email = fromEmail.toLowerCase();
  const exact = rules.find((r) => r.kind === "sender" && r.pattern.toLowerCase() === email && accept(r.folder));
  if (exact) return exact;
  const domain = domainOf(email);
  // サブドメインも含めて一致させる（mail.example.co.jp は example.co.jp のルールに当たる）
  const domainRules = rules
    .filter((r) => r.kind === "domain" && accept(r.folder))
    .filter((r) => {
      const p = r.pattern.toLowerCase().replace(/^@/, "");
      return domain === p || domain.endsWith(`.${p}`);
    })
    .sort((a, b) => b.pattern.length - a.pattern.length);
  return domainRules[0] ?? null;
}

export function matchSenderRule(fromEmail: string | undefined, rules: SenderRule[]): SenderRule | null {
  return matchRule(fromEmail, rules, isFolder);
}

/** 「今後も迷惑メールへ」にした送信者・ドメインか */
export function matchBlockRule(fromEmail: string | undefined, rules: SenderRule[]): SenderRule | null {
  return matchRule(fromEmail, rules, (t) => t === BLOCK_RULE);
}

export function classifyByHeaders(
  msg: Pick<ParsedMessage, "from" | "to" | "cc" | "deliveredTo" | "listId">,
  senderRules: SenderRule[],
  addresses: AddressEntry[],
): Stage1Result {
  const byAddress = new Map(addresses.map((a) => [a.address.toLowerCase(), a]));
  const lookup = (email: string) => byAddress.get(email.toLowerCase());

  // To を優先、次に List-Id / Delivered-To（グループ経由）、最後に Cc
  const toHits = msg.to.map((a) => lookup(a.email)).filter((x): x is AddressEntry => Boolean(x));
  const listAddress = listIdToAddress(msg.listId);
  const groupHits = [listAddress, ...msg.deliveredTo]
    .filter((x): x is string => Boolean(x))
    .map(lookup)
    .filter((x): x is AddressEntry => Boolean(x));
  const ccHits = msg.cc.map((a) => lookup(a.email)).filter((x): x is AddressEntry => Boolean(x));

  // 業務用アドレス（contentDecides でないもの）を個人アドレスより優先する
  const ordered = [...toHits, ...groupHits, ...ccHits];
  const primary = ordered.find((a) => !a.contentDecides) ?? ordered[0] ?? null;
  const secondary = new Set<Folder>();
  for (const hit of ordered) {
    if (hit !== primary && !hit.contentDecides && isFolder(hit.folder) && hit.folder !== primary?.folder) {
      secondary.add(hit.folder);
    }
  }

  const rule = matchSenderRule(msg.from?.email, senderRules);
  if (rule && isFolder(rule.folder)) {
    if (primary && !primary.contentDecides && isFolder(primary.folder) && primary.folder !== rule.folder) {
      secondary.add(primary.folder);
    }
    secondary.delete(rule.folder);
    return {
      folder: rule.folder,
      source: rule.kind === "sender" ? "sender_rule" : "domain_rule",
      contentDecides: false,
      secondaryFolders: [...secondary],
      matchedAddress: primary?.address ?? null,
    };
  }

  if (primary && isFolder(primary.folder)) {
    return {
      folder: primary.folder,
      source: "address",
      contentDecides: primary.contentDecides,
      secondaryFolders: [...secondary],
      matchedAddress: primary.address,
    };
  }

  return {
    folder: null,
    source: "none",
    contentDecides: true,
    secondaryFolders: [...secondary],
    matchedAddress: null,
  };
}

export { PERSONAL_FOLDER_KEY };
