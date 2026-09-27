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
| 4章 通知 | 至急の要返信をスマホ・パソコンに通知（Web Push）。ホーム画面に追加して使える | `src/lib/notify.ts`, `public/sw.js` |
| P4 | 連絡先メモと夜間の関係要約（Message Batches）、Shopify の注文照会（任意） | `src/lib/contacts.ts`, `src/lib/shopify.ts` |
| P4 freee | 経理フォルダの請求書・領収書の PDF や画像を、freee 会計のファイルボックスに送る（二重送信しない） | `src/lib/freee.ts`, `src/lib/freee-service.ts` |

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

Google Workspace と Google Cloud の管理者権限が必要です。Google Cloud 側は `deploy/setup-gcp.sh` がほぼ全てを行います。

1. **用途別アドレスを作る（手作業）。** Google Workspace 管理コンソールで keiri@・wholesale@ などを Google グループ（共同トレイ）として作り、担当者をメンバーにします。返信の送信元にしたい人は、Gmail の設定「他のメールアドレスを追加」でそのアドレスを登録します。登録していなければ個人のアドレスから返信します。
2. **Google Cloud の土台を作る。** API の有効化、サービスアカウント、Gmail 通知用の Pub/Sub、Cloud SQL、秘密の値（セッション鍵・暗号鍵・cron 用・通知の鍵・DB の接続先）の生成まで行います。

   ```sh
   PROJECT_ID=<プロジェクト> REGION=asia-northeast1 ./deploy/setup-gcp.sh infra
   ```

3. **OAuth クライアントを作る（手作業）。** コンソールの「OAuth 同意画面」を「内部」で作り、「認証情報」でウェブアプリの OAuth クライアントを作ります。リダイレクト URI は `<公開URL>/api/auth/callback`、JavaScript 生成元は `<公開URL>` です。できたクライアント ID・シークレットと Anthropic の API キーを、スクリプトが最後に表示するコマンドで Secret Manager に入れます。
4. **デプロイする。** Cloud Build でコンテナを作り Cloud Run に出します。DB のマイグレーションはコンテナの起動時に自動で行います。最初の公開 URL は Cloud Run の URL でかまいません。独自ドメインにしたら、OAuth の設定と `APP_URL` を変えてもう一度実行します。

   ```sh
   PROJECT_ID=<プロジェクト> APP_URL=https://<公開URL> ./deploy/setup-gcp.sh deploy
   ```

5. **通知と定期実行をつなぐ。** Gmail の受信通知の送り先と、Cloud Scheduler の2つの定期実行を作ります。

   ```sh
   PROJECT_ID=<プロジェクト> APP_URL=https://<公開URL> ./deploy/setup-gcp.sh wire
   ```

   | 送信先 | 頻度 | 役割 |
   | --- | --- | --- |
   | `/api/cron/tick` | 5 分ごと | 通知の取りこぼしを拾う、watch の更新、残ったジョブの実行 |
   | `/api/cron/nightly` | 毎日 2:00（日本時間） | 連絡先ごとのやりとりの要約 |

6. **ログインする。** `ADMIN_EMAILS` の人（既定は isozaki@）が最初にログインし、設定画面で担当者を追加します。担当者は各自ログインすると自分の受信箱が連携されます。過去のメールを分類したいときは設定画面の「過去のメールの取り込み」を使います。

### 任意の連携

- **freee 会計。** freee アプリストアの開発者ページでアプリを作り、コールバック URL を `<公開URL>/api/freee/callback` にします。クライアント ID・シークレットを `FREEE_CLIENT_ID`・`FREEE_CLIENT_SECRET` として Secret Manager に入れて再デプロイし、設定画面の「freee と連携する」を押します。
- **Shopify。** `SHOPIFY_STORE_DOMAIN`・`SHOPIFY_ADMIN_TOKEN`（注文の読み取り権限だけのカスタムアプリ）を入れると、注文・配送の下書きに注文情報を使います。
- **通知。** 鍵は手順 2 で作られます。各自がメニューの「通知を受け取る」を押した端末に届きます。iPhone は Safari の共有メニューから「ホーム画面に追加」したアプリで押してください。

## 開発

```sh
npm ci
npm test          # PGlite（メモリ上の Postgres）と偽の Gmail で動くテスト
npm run typecheck
npm run build
npm run db:migrate   # 手元の Postgres に表を作る（DATABASE_URL と ALLOWED_DOMAIN が必要）
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
- **Cloud SQL** は最小構成（db-f1-micro）で作ります。利用者が増えたら上げてください。
- **請求書 PDF** は Claude に送りません（11 章）。
- **freee 連携**は証憑（ファイルボックス）への送信までです。取引の登録や勘定科目の判断はせず、仕訳は経理担当が freee の画面で行います。送るのは人がボタンを押したときだけです。
- **通知**は既定で「至急の要返信」だけです。設定画面で「要返信すべて」「通知しない」に変えられます。通知には要約だけを出し、本文は出しません。
- **Claude のモデル**は、下書きが `claude-opus-5`（effort medium、安全上の理由で止まったときはサーバー側で推奨モデルに切り替える `fallbacks: "default"`）、分類と要約が `claude-haiku-4-5` です。環境変数で変えられます。
