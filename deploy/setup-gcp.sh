#!/usr/bin/env bash
# 悠三堂メールの Google Cloud 側の準備（仕様書 P0）。何度実行しても壊れないように作ってある。
#
#   PROJECT_ID=yusando-mail REGION=asia-northeast1 ./deploy/setup-gcp.sh infra
#   （OAuth クライアントと API キーを Secret Manager に入れる。下の「手作業」を参照）
#   PROJECT_ID=yusando-mail REGION=asia-northeast1 APP_URL=https://mail.yusando.com ./deploy/setup-gcp.sh deploy
#   PROJECT_ID=yusando-mail REGION=asia-northeast1 APP_URL=https://mail.yusando.com ./deploy/setup-gcp.sh wire
#
# 手作業で必要なこと（コンソールでしかできない）:
#   1. Google Workspace 管理コンソールで用途別アドレスを Google グループとして作る
#   2. 「API とサービス > OAuth 同意画面」を「内部」で作り、「認証情報」でウェブアプリの OAuth クライアントを作る
#      リダイレクト URI: <APP_URL>/api/auth/callback　JavaScript 生成元: <APP_URL>
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID を指定してください}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-yusando-mail}"
DOMAIN="${ALLOWED_DOMAIN:-yusando.com}"
ADMINS="${ADMIN_EMAILS:-isozaki@${DOMAIN}}"
SQL_INSTANCE="${SQL_INSTANCE:-yusando-mail}"
TOPIC="gmail-inbox"
RUN_SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"
PUSH_SA="${SERVICE}-push@${PROJECT_ID}.iam.gserviceaccount.com"

gc() { gcloud --project "$PROJECT_ID" "$@"; }
exists_secret() { gc secrets describe "$1" >/dev/null 2>&1; }
put_secret() {
  # put_secret NAME VALUE（無ければ作る。あれば新しい版を足す）
  if exists_secret "$1"; then printf %s "$2" | gc secrets versions add "$1" --data-file=- >/dev/null
  else printf %s "$2" | gc secrets create "$1" --replication-policy=automatic --data-file=- >/dev/null; fi
  echo "  secret $1 を保存しました"
}
ensure_generated_secret() {
  # 無いときだけ作る（作り直すとログイン中のセッションや保存済みトークンが無効になるため）
  if exists_secret "$1"; then echo "  secret $1 は既にあります"; else put_secret "$1" "$2"; fi
}

infra() {
  echo "== API を有効にする"
  gc services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    secretmanager.googleapis.com sqladmin.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com \
    gmail.googleapis.com calendar-json.googleapis.com iam.googleapis.com

  echo "== コンテナの置き場所"
  gc artifacts repositories describe "$SERVICE" --location "$REGION" >/dev/null 2>&1 ||
    gc artifacts repositories create "$SERVICE" --repository-format=docker --location "$REGION"

  echo "== サービスアカウント"
  gc iam service-accounts describe "$RUN_SA" >/dev/null 2>&1 ||
    gc iam service-accounts create "${SERVICE}-run" --display-name "悠三堂メール（実行）"
  gc iam service-accounts describe "$PUSH_SA" >/dev/null 2>&1 ||
    gc iam service-accounts create "${SERVICE}-push" --display-name "悠三堂メール（Gmail 通知）"
  for role in roles/secretmanager.secretAccessor roles/cloudsql.client; do
    gc projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$RUN_SA" --role "$role" --condition=None >/dev/null
  done
  local number
  number="$(gc projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  # Cloud Build がデプロイできるように（新しいプロジェクトは Compute の既定のアカウントでビルドする）
  for sa in "${number}@cloudbuild.gserviceaccount.com" "${number}-compute@developer.gserviceaccount.com"; do
    for role in roles/run.admin roles/iam.serviceAccountUser roles/secretmanager.secretAccessor \
      roles/artifactregistry.writer roles/logging.logWriter; do
      gc projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${sa}" --role "$role" --condition=None >/dev/null
    done
  done
  # Pub/Sub が push 用の ID トークンを作れるように
  gc iam service-accounts add-iam-policy-binding "$PUSH_SA" \
    --member "serviceAccount:service-${number}@gcp-sa-pubsub.iam.gserviceaccount.com" \
    --role roles/iam.serviceAccountTokenCreator >/dev/null

  echo "== Gmail の受信通知のトピック"
  gc pubsub topics describe "$TOPIC" >/dev/null 2>&1 || gc pubsub topics create "$TOPIC"
  gc pubsub topics add-iam-policy-binding "$TOPIC" \
    --member serviceAccount:gmail-api-push@system.gserviceaccount.com --role roles/pubsub.publisher >/dev/null

  echo "== データベース（Cloud SQL for PostgreSQL）"
  if ! gc sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    gc sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_16 --edition=enterprise \
      --tier=db-f1-micro --region "$REGION" --storage-auto-increase
  fi
  gc sql databases describe yusando_mail --instance "$SQL_INSTANCE" >/dev/null 2>&1 ||
    gc sql databases create yusando_mail --instance "$SQL_INSTANCE"
  if ! exists_secret DATABASE_URL; then
    local pass
    pass="$(openssl rand -hex 24)"
    gc sql users create app --instance "$SQL_INSTANCE" --password "$pass" >/dev/null
    put_secret DATABASE_URL "postgres://app:${pass}@localhost/yusando_mail?host=/cloudsql/${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
  fi

  echo "== 自動で作れる秘密の値"
  ensure_generated_secret SESSION_SECRET "$(openssl rand -hex 32)"
  ensure_generated_secret TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  ensure_generated_secret CRON_SECRET "$(openssl rand -hex 24)"
  if ! exists_secret VAPID_PRIVATE_KEY; then
    local keys
    keys="$(npx --yes web-push generate-vapid-keys --json)"
    put_secret VAPID_PUBLIC_KEY "$(node -e 'console.log(JSON.parse(process.argv[1]).publicKey)' "$keys")"
    put_secret VAPID_PRIVATE_KEY "$(node -e 'console.log(JSON.parse(process.argv[1]).privateKey)' "$keys")"
  fi

  cat <<MSG

== 次に手作業で入れる値（Secret Manager）
  printf %s '<OAuth クライアント ID>'     | gcloud --project $PROJECT_ID secrets create GOOGLE_CLIENT_ID --data-file=-
  printf %s '<OAuth クライアントシークレット>' | gcloud --project $PROJECT_ID secrets create GOOGLE_CLIENT_SECRET --data-file=-
  printf %s '<Anthropic の API キー>'      | gcloud --project $PROJECT_ID secrets create ANTHROPIC_API_KEY --data-file=-
  任意: FREEE_CLIENT_ID / FREEE_CLIENT_SECRET / SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN も同じ形で
MSG
}

deploy() {
  : "${APP_URL:?APP_URL（公開 URL）を指定してください。最初は Cloud Run の URL でよい}"
  gc builds submit --config deploy/cloudbuild.yaml \
    --substitutions "_REGION=${REGION},_SERVICE=${SERVICE},_APP_URL=${APP_URL},_DOMAIN=${DOMAIN},_ADMINS=${ADMINS//,/;},_SQL=${PROJECT_ID}:${REGION}:${SQL_INSTANCE},_TOPIC=projects/${PROJECT_ID}/topics/${TOPIC},_PUSH_SA=${PUSH_SA},_RUN_SA=${RUN_SA}" .
}

wire() {
  : "${APP_URL:?APP_URL（公開 URL）を指定してください}"
  echo "== Gmail の受信通知をアプリに届ける（push サブスクリプション）"
  local endpoint="${APP_URL}/api/gmail/push"
  if gc pubsub subscriptions describe gmail-inbox-push >/dev/null 2>&1; then
    gc pubsub subscriptions modify-push-config gmail-inbox-push --push-endpoint "$endpoint" \
      --push-auth-service-account "$PUSH_SA" --push-auth-token-audience "$endpoint"
  else
    gc pubsub subscriptions create gmail-inbox-push --topic "$TOPIC" --push-endpoint "$endpoint" \
      --push-auth-service-account "$PUSH_SA" --push-auth-token-audience "$endpoint" --ack-deadline 300
  fi

  echo "== 定期実行（Cloud Scheduler）"
  local secret
  secret="$(gc secrets versions access latest --secret CRON_SECRET)"
  schedule_job() {
    local name="$1" schedule="$2" path="$3"
    local args=(--location "$REGION" --schedule "$schedule" --time-zone "Asia/Tokyo" --uri "${APP_URL}${path}"
      --http-method POST --headers "Authorization=Bearer ${secret}" --attempt-deadline 320s)
    if gc scheduler jobs describe "$name" --location "$REGION" >/dev/null 2>&1; then
      gc scheduler jobs update http "$name" "${args[@]}"
    else
      gc scheduler jobs create http "$name" "${args[@]}"
    fi
  }
  schedule_job "${SERVICE}-tick" "*/5 * * * *" /api/cron/tick
  schedule_job "${SERVICE}-nightly" "0 2 * * *" /api/cron/nightly
  echo "完了。${APP_URL}/login から ${ADMINS} でログインしてください。"
}

case "${1:-}" in
  infra) infra ;;
  deploy) deploy ;;
  wire) wire ;;
  *) echo "使い方: $0 infra | deploy | wire（ファイル先頭の説明を参照）"; exit 1 ;;
esac
