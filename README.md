# 悠三堂メール

悠三堂の業務メールを、用途別アドレスで自動に振り分け、Claude が返信の下書きを用意し、日程は Google カレンダーに登録できるメールアプリです。
仕様書：[悠三堂メールアプリ 仕様書（ドラフト v0.1）](https://claude.ai/code/artifact/a2c4e0e1-3cc1-479f-b18f-5eec8085d511)

メールの原本は Gmail に置いたままです。このアプリは Gmail の上に乗る業務用の画面で、DB には分類結果・ルール・下書きとの対応だけを持ち、メール本文は保存しません。

## できること

| 仕様書 | 機能 | 主なファイル |
| --- | --- | --- |
| 3章 基本機能 | 受信一覧・閲覧・添付・新規作成・転送・検索・アーカイブ・迷惑メール・ゴミ箱 | `src/app/(app)/` |
| 4章 振り分け | 宛先アドレスで一次分類、Claude（claude-haiku-4-5）で内容・要返信・緊急度・言語・日程・金額を判定し、合成ルールでフォルダを決めて Gmail ラベルを付ける | `src/lib/classify/`, `src/lib/pipeline.ts` |
| 4章 学習 | フォルダを直すときに「今後もこの送信者／ドメインは」を選ぶと送信者ルールになる | `src/app/actions/mail.ts` |
| 5章 下書き | 要返信のメールに Claude（claude-opus-5）が Gmail の下書きを作る。【要確認】が残っている間は送信できない。人が直した下書きは上書きせず別案として並べる | `src/lib/drafts.ts`, `src/lib/claude/drafter.ts` |
| 6章 カレンダー | 日程候補の表示、仮予定の登録、空き時間から候補3つの提案、支払期日の終日予定、承諾の返信で確定の提案 | `src/lib/calendar-service.ts`, `src/lib/slots.ts` |
| 8章 画面 | フォルダ・一覧・本文・下書き・日程・連絡先・今日の予定・設定。キーボード操作（j/k/Enter/e/r/u//）。スマホ表示 | `src/app/`, `src/components/` |
| 11章 権限 | yusando.com の Google アカウントのみ。管理者と担当者（見られるフォルダを指定）。操作の記録 | `src/lib/access.ts`, `src/lib/audit.ts` |
| P4 | 連絡先メモと夜間の関係要約（Message Batches）、Shopify の注文照会（任意） | `src/lib/contacts.ts`, `src/lib/shopify.ts` |

### 送信について

サーバーはメールを送信しません。送信 API を呼ぶのはブラウザの送信ボタン（`src/components/send-button.tsx`）だけで、押した本人から Google に `gmail.compose` の一時的な許可をもらって送ります。`tests/no-send.test.ts` がこの約束を確かめます。

## 構成

- Next.js 16（App Router）+ TypeScript、Node.js 22
- PostgreSQL + Drizzle ORM（マイグレーションは `drizzle/`）
- Gmail API・Google Calendar API（`@googleapis/*`）。受信通知は Gmail → Pub/Sub → `/api/gmail/push`
- Claude API（`@anthropic-ai/sdk`）
- 非同期処理は DB のジョブキュー（`jobs` テーブル）。受信通知と 5 分ごとの cron で進める
- デプロイ先は Cloud Run を想定（`Dockerfile`）

## 初回セットアップ（仕様書のフェーズ P0）

Google Workspace の管理者権限が必要です。

1. **用途別アドレスを作る。** Google Workspace 管理コンソールで keiri@・wholesale@ などを Google グループ（共同トレイ）として作り、担当者をメンバーにします。返信の送信元にしたい人は、Gmail の設定「他のメールアドレスを追加」でそのアドレスを登録します。登録していなければ個人のアドレスから返信します。
2. **GCP プロジェクトを用意する。** Gmail API、Google Calendar API、Cloud Pub/Sub API を有効にします。
3. **OAuth を設定する。** 同意画面は「内部」にします。OAuth クライアント（ウェブアプリ）を作り、承認済みのリダイレクト URI に `https://<公開URL>/api/auth/callback` を、承認済みの JavaScript 生成元に `https://<公開URL>` を入れます。
4. **Pub/Sub を設定する。** トピックを作り、`gmail-api-push@system.gserviceaccount.com` にパブリッシャー権限を付けます。push サブスクリプションの送信先は `https://<公開URL>/api/gmail/push` にし、認証を有効にしてサービスアカウントを選び、オーディエンスを同じ URL にします。
5. **PostgreSQL を用意する。** Cloud SQL など。
6. **環境変数を入れてデプロイする。** `.env.example` を参照してください。秘密の値は Secret Manager に置きます。デプロイのたびに次を実行します。

   ```sh
   DATABASE_URL=... ALLOWED_DOMAIN=yusando.com npm run db:migrate
   ```

7. **Cloud Scheduler を設定する。** どちらも POST で、ヘッダ `Authorization: Bearer <CRON_SECRET>` を付けます。

   | 送信先 | 頻度 | 役割 |
   | --- | --- | --- |
   | `/api/cron/tick` | 5 分ごと | 通知の取りこぼしを拾う、watch の更新、残ったジョブの実行 |
   | `/api/cron/nightly` | 毎日 2:00（日本時間） | 連絡先ごとのやりとりの要約 |

8. **ログインする。** `ADMIN_EMAILS` の人が最初にログインし、設定画面で担当者を追加します。担当者は各自ログインすると自分の受信箱が連携されます。過去のメールを分類したいときは設定画面の「過去のメールの取り込み」を使います。

## 開発

```sh
npm ci
npm test          # PGlite（メモリ上の Postgres）と偽の Gmail で動くテスト
npm run typecheck
npm run build
```

## 仕様書から仮に決めたこと

仕様書 13 章の未確定事項は、次の既定で実装しています。どれも設定か小さな変更で切り替えられます。

- **アドレス名**は仕様書 7 章の案のままです。設定画面で追加・変更できます。
- **個人アドレス宛て**は「個人」フォルダに置き、内容で判定した業務フォルダを副ラベルで付けます（7 章の表に合わせました）。業務フォルダの一覧にも表示されます。
- **リターン（CAMPFIRE）**をカテゴリに加えました。5 章のプレイブックに含まれていたためです。
- **グループ宛てで複数人に届いたメール**は、分類を Message-ID で使い回し、自動下書きは最初に処理した 1 人の受信箱だけに作ります。他の人は画面から作れます。
- **自動下書き**は経理と情報・ニュースレター以外で ON です。設定画面で切り替えられます。
- **カレンダー**は全種類とも「メイン」に登録します。設定画面で種類ごとに変えられます。相手に招待メールは送りません。
- **ホスティング**は Cloud Run を想定しました。Pub/Sub の push 先を変えれば他の環境でも動きます。
- **Cloud Tasks** の代わりに DB のジョブキューを使います。追加のサービスが要らないためです。
- **請求書 PDF** は Claude に送りません（11 章）。
- **freee 連携**は実装していません。仕様書でもフェーズ 4 以降で、当面は経理フォルダから手で取り込む扱いです。
- **Claude のモデル**は、下書きが `claude-opus-5`（effort medium、安全上の理由で止まったときはサーバー側で推奨モデルに切り替える `fallbacks: "default"`）、分類と要約が `claude-haiku-4-5` です。環境変数で変えられます。
