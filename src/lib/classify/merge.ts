import {
  PERSONAL_FOLDER_KEY,
  REVIEW_CONFIDENCE_THRESHOLD,
  type Category,
  type Folder,
} from "../domain";
import type { Stage1Result } from "./stage1";
import type { ContentClassification } from "./types";

export interface MergedClassification {
  folder: Folder;
  category: Category | null;
  secondaryFolders: Folder[];
  source: "sender_rule" | "domain_rule" | "address" | "content";
  needsReview: boolean;
}

/**
 * 判定の合成ルール（仕様書 4章）
 * 1. 送信者ルール > 宛先ルール > 内容分類
 * 2. 宛先と内容が一致 → 確定。不一致 → 内容を優先し「要確認」
 * 3. 個人・総合窓口アドレス宛ては内容で決める（不一致扱いにしない）
 * 4. 信頼度 0.7 未満は「要確認」
 */
export function mergeClassification(
  stage1: Stage1Result,
  content: ContentClassification | null,
): MergedClassification {
  const secondary = new Set(stage1.secondaryFolders);
  const lowConfidence = content ? content.confidence < REVIEW_CONFIDENCE_THRESHOLD : false;

  if ((stage1.source === "sender_rule" || stage1.source === "domain_rule") && stage1.folder) {
    return {
      folder: stage1.folder,
      category: stage1.folder === PERSONAL_FOLDER_KEY ? (content?.category ?? null) : stage1.folder,
      secondaryFolders: [...secondary],
      source: stage1.source,
      needsReview: false,
    };
  }

  if (!content) {
    // 内容分類に失敗したときは宛先の結果だけで置き、要確認にする
    return {
      folder: stage1.folder ?? PERSONAL_FOLDER_KEY,
      category: stage1.folder && stage1.folder !== PERSONAL_FOLDER_KEY ? stage1.folder : null,
      secondaryFolders: [...secondary],
      source: "address",
      needsReview: true,
    };
  }

  if (stage1.source === "address" && stage1.folder && !stage1.contentDecides) {
    if (stage1.folder === content.category) {
      return {
        folder: stage1.folder,
        category: content.category,
        secondaryFolders: [...secondary].filter((f) => f !== stage1.folder),
        source: "address",
        needsReview: lowConfidence,
      };
    }
    // 不一致：内容を優先し、宛先のフォルダは副ラベルとして残す
    secondary.add(stage1.folder);
    secondary.delete(content.category);
    return {
      folder: content.category,
      category: content.category,
      secondaryFolders: [...secondary],
      source: "content",
      needsReview: true,
    };
  }

  // 個人アドレス・総合窓口・どの用途別アドレスにも当たらない
  if (stage1.folder === PERSONAL_FOLDER_KEY && content.category !== "info") {
    // 個人フォルダに置いたまま、業務フォルダを副ラベルで付ける
    secondary.add(content.category);
  }
  const folder: Folder =
    stage1.folder === PERSONAL_FOLDER_KEY ? PERSONAL_FOLDER_KEY : content.category;
  secondary.delete(folder);
  return {
    folder,
    category: content.category,
    secondaryFolders: [...secondary],
    source: "content",
    needsReview: lowConfidence,
  };
}
