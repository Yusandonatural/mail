/**
 * 下書き内の【要確認：…】（英語の下書きでは [CONFIRM: …] も）を扱う。
 * 全て埋まるまで送信ボタンを押せないようにする（仕様書 5章）。
 */
const PATTERN = /【要確認[:：]?([^】]*)】|\[CONFIRM[:：]?([^\]]*)\]/g;

export interface Placeholder {
  label: string;
  index: number;
  raw: string;
}

export function findPlaceholders(text: string): Placeholder[] {
  const result: Placeholder[] = [];
  for (const m of text.matchAll(PATTERN)) {
    result.push({ label: (m[1] ?? m[2] ?? "").trim(), index: m.index ?? 0, raw: m[0] });
  }
  return result;
}

export function hasPlaceholders(text: string): boolean {
  return findPlaceholders(text).length > 0;
}
