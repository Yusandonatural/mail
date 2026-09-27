import { describe, expect, it } from "vitest";
import { classifyByHeaders, matchSenderRule, type AddressEntry } from "@/lib/classify/stage1";
import { parseAddressList } from "@/lib/mail/parse";

const addresses: AddressEntry[] = [
  { address: "keiri@yusando.com", folder: "keiri", contentDecides: false },
  { address: "wholesale@yusando.com", folder: "wholesale", contentDecides: false },
  { address: "tour@yusando.com", folder: "tour", contentDecides: false },
  { address: "info@yusando.com", folder: "general", contentDecides: true },
  { address: "isozaki@yusando.com", folder: "personal", contentDecides: true },
];

function msg(to: string, opts: { cc?: string; from?: string; listId?: string; deliveredTo?: string[] } = {}) {
  return {
    from: parseAddressList(opts.from ?? "buyer@shop.example")[0],
    to: parseAddressList(to),
    cc: parseAddressList(opts.cc ?? ""),
    deliveredTo: opts.deliveredTo ?? [],
    listId: opts.listId ?? null,
  };
}

describe("一次分類（宛先アドレス）", () => {
  it("用途別アドレス宛てはそのフォルダになる", () => {
    const r = classifyByHeaders(msg("wholesale@yusando.com"), [], addresses);
    expect(r).toMatchObject({ folder: "wholesale", source: "address", contentDecides: false });
  });

  it("To を優先し、Cc の用途別アドレスは副ラベルになる", () => {
    const r = classifyByHeaders(msg("tour@yusando.com", { cc: "keiri@yusando.com" }), [], addresses);
    expect(r.folder).toBe("tour");
    expect(r.secondaryFolders).toEqual(["keiri"]);
  });

  it("個人アドレスと業務アドレスの両方に届いたら業務アドレスを優先する", () => {
    const r = classifyByHeaders(msg("isozaki@yusando.com, wholesale@yusando.com"), [], addresses);
    expect(r.folder).toBe("wholesale");
    expect(r.contentDecides).toBe(false);
  });

  it("個人アドレス宛ては個人フォルダで、内容で決め直す", () => {
    const r = classifyByHeaders(msg("礒﨑 <isozaki@yusando.com>"), [], addresses);
    expect(r).toMatchObject({ folder: "personal", contentDecides: true });
  });

  it("Google グループ経由（List-Id）でも用途別アドレスを判定する", () => {
    const r = classifyByHeaders(msg("undisclosed-recipients:;", { listId: "keiri <keiri.yusando.com>" }), [], addresses);
    expect(r.folder).toBe("keiri");
  });

  it("どれにも当たらなければフォルダ未定", () => {
    const r = classifyByHeaders(msg("someone@else.example"), [], addresses);
    expect(r).toMatchObject({ folder: null, source: "none" });
  });

  it("送信者ルールは宛先ルールより優先し、宛先のフォルダは副ラベルに残す", () => {
    const rules = [{ kind: "sender" as const, pattern: "tax@office.example", folder: "keiri" }];
    const r = classifyByHeaders(msg("wholesale@yusando.com", { from: "tax@office.example" }), rules, addresses);
    expect(r).toMatchObject({ folder: "keiri", source: "sender_rule" });
    expect(r.secondaryFolders).toEqual(["wholesale"]);
  });
});

describe("送信者ルール", () => {
  const rules = [
    { kind: "domain" as const, pattern: "example.co.jp", folder: "keiri" },
    { kind: "domain" as const, pattern: "bank.example.co.jp", folder: "general" },
    { kind: "sender" as const, pattern: "Boss@Example.co.jp", folder: "press" },
  ];
  it("完全一致の送信者ルールをドメインより優先する（大文字小文字は無視）", () => {
    expect(matchSenderRule("boss@example.co.jp", rules)?.folder).toBe("press");
  });
  it("サブドメインにも当たり、より長いドメインを優先する", () => {
    expect(matchSenderRule("a@mail.example.co.jp", rules)?.folder).toBe("keiri");
    expect(matchSenderRule("a@bank.example.co.jp", rules)?.folder).toBe("general");
  });
  it("似ているが別のドメインには当たらない", () => {
    expect(matchSenderRule("a@notexample.co.jp", rules)).toBeNull();
  });
});
