import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/**
 * 仕様書 11章「サーバーに送信 API を呼ぶコードを置かない」を守っているかの確認。
 * 送信はブラウザの送信ボタン（send-button.tsx）だけが、本人のトークンで行う。
 */
describe("サーバーからメールを送れないこと", () => {
  it("送信 API を呼ぶのはブラウザ側の送信ボタンだけ", () => {
    const offenders = files("src").filter((f) => {
      if (f.endsWith("send-button.tsx")) return false;
      // コメント中の説明（「送信は含めていない」など）は対象外にする
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return /(messages|drafts)\.send\b|\/drafts\/send|\/messages\/send/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("送信ボタンはクライアントコンポーネントである", () => {
    const button = files("src").find((f) => f.endsWith("send-button.tsx"));
    expect(button).toBeDefined();
    expect(readFileSync(button!, "utf8").trimStart().startsWith('"use client"')).toBe(true);
  });
});
