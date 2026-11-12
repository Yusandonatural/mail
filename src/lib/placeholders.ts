/**
 * 下書き内の【要確認：…】（英語の下書きでは [CONFIRM: …] [TBC: …] も）を扱う。
 * 全て埋まるまで送信ボタンを押せないようにする（仕様書 5章）。
 * 送ってはいけないものを見逃さないよう広めに拾う：全角・半角の括弧（【】［］[]〔〕）、
 * 括弧の内側の空白、大文字小文字の違い、閉じ括弧の抜け（その行の終わりまでを空欄とみなす）。
 */
const PATTERN = /[【［[〔]\s*(?:要確認|(?:CONFIRM|TBC|TBD)\b)\s*[:：]?\s*([^】］\]〕\n]*)[】］\]〕]?/gi;

export interface Placeholder {
  label: string;
  index: number;
  raw: string;
}

export function findPlaceholders(text: string): Placeholder[] {
  const result: Placeholder[] = [];
  for (const m of text.matchAll(PATTERN)) {
    result.push({ label: (m[1] ?? "").trim(), index: m.index ?? 0, raw: m[0] });
  }
  return result;
}

export function hasPlaceholders(text: string): boolean {
  return findPlaceholders(text).length > 0;
}
