"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * キーボード操作（仕様書 8章）
 * j/k: 一覧で次・前へ　Enter/o: 開く　e: アーカイブ　r: 下書き欄へ　u: 一覧へ戻る　/: 検索
 * x: 一覧で選んだ行にチェック　!: 迷惑メール　#: ゴミ箱（一覧では選んだ行、メール画面ではそのメール）
 */
export function KeyboardNav() {
  const router = useRouter();
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.row"));
      const current = rows.findIndex((r) => r.classList.contains("selected"));
      const select = (i: number) => {
        rows.forEach((r) => r.classList.remove("selected"));
        const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
        if (r) {
          r.classList.add("selected");
          r.scrollIntoView({ block: "nearest" });
        }
      };
      switch (ev.key) {
        case "j":
          if (rows.length) select(current + 1);
          break;
        case "k":
          if (rows.length) select(current < 0 ? 0 : current - 1);
          break;
        case "o":
        case "Enter":
          if (current >= 0) router.push(rows[current].getAttribute("href") ?? "/inbox");
          break;
        case "x": {
          const box = rows[current]?.closest(".row-line")?.querySelector<HTMLInputElement>('input[name="sel"]');
          if (box) {
            box.checked = !box.checked;
            box.dispatchEvent(new Event("change", { bubbles: true }));
          }
          break;
        }
        case "!":
        case "#": {
          const attr = ev.key === "!" ? "data-spam" : "data-trash";
          const scope = rows.length ? rows[current]?.closest(".row-line") : document;
          scope?.querySelector<HTMLButtonElement>(`button[${attr}]`)?.click();
          break;
        }
        case "e":
          document.querySelector<HTMLButtonElement>("button[data-archive]")?.click();
          break;
        case "r":
          ev.preventDefault();
          document.querySelector<HTMLTextAreaElement>("textarea[data-draft]")?.focus();
          break;
        case "u":
          document.querySelector<HTMLAnchorElement>("a[data-back]")?.click();
          break;
        case "/":
          ev.preventDefault();
          router.push("/search");
          break;
        default:
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
