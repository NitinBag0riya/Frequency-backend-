#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════
# bin/deploy.sh — one-shot Frequency production deploy.
#
# Prerequisites (one-time):
#   1. flyctl auth login    # → opens browser, click Approve
#   2. vercel login         # → opens browser, click Approve
#   3. cp .env.deploy.example .env.deploy && fill in third-party API keys
#
# Then:                     ./bin/deploy.sh
#
# What this does:
#   • Reads .env.deploy (gitignored) for all secrets
#   • Creates the Fly.io app if it doesn't exist (else uses existing)
#   • Pushes every secret to Fly via `fly secrets set`
#   • Runs `fly deploy` which builds the Dockerfile + boots web + worker
#   • Links the FE worktree to a Vercel project + sets env vars + deploys
#   • Prints final URLs and webhook configuration steps
#
# Idempotent: re-running just updates secrets + redeploys; no duplicate
# resources are created.
# ═════════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 0. Pre-flight checks ──────────────────────────────────────────────────
echo "▶ Pre-flight checks"

if ! command -v flyctl &> /dev/null; then
  echo "❌ flyctl not installed. Install: brew install flyctl"
  exit 1
fi

if ! flyctl auth whoami &> /dev/null; then
  echo "❌ flyctl not authenticated. Run: flyctl auth login"
  exit 1
fi
FLY_USER=$(flyctl auth whoami)
echo "  ✓ flyctl authed as: $FLY_USER"

if [ ! -f ".env.deploy" ]; then
  echo "❌ .env.deploy missing. Copy from template:"
  echo "    cp .env.deploy.example .env.deploy"
  echo "    # then fill in the third-party API keys"
  exit 1
fi

# Source the env file (allexport mode = every var becomes env)
set -o allexport
# shellcheck disable=SC1091
source .env.deploy
set +o allexport

# Verify required values are filled
REQUIRED=(
  IMPERSONATION_HMAC_SECRET OAUTH_STATE_SECRET ENCRYPTION_KEY
  WH_VERIFY_TOKEN META_VERIFY_TOKEN GOOGLE_TOKEN_SECRET
  FLY_APP_NAME FLY_REGION VERCEL_PROJECT_NAME
  SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY
  ANTHROPIC_API_KEY
  META_APP_ID META_APP_SECRET
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET
  RESEND_API_KEY RESEND_FROM_EMAIL
  REDIS_URL
)
MISSING=()
for var in "${REQUIRED[@]}"; do
  if [ -z "${!var:-}" ]; then MISSING+=("$var"); fi
done
if [ ${#MISSING[@]} -ne 0 ]; then
  echo "❌ .env.deploy is missing required values:"
  printf '   - %s\n' "${MISSING[@]}"
  exit 1
fi
echo "  ✓ .env.deploy populated"

# ── 1. Fly.io: create app if needed ───────────────────────────────────────
echo
echo "▶ Fly.io setup"

if flyctl apps list 2>/dev/null | grep -q "^$FLY_APP_NAME "; then
  echo "  ✓ App $FLY_APP_NAME already exists"
else
  echo "  Creating app $FLY_APP_NAME in $FLY_REGION..."
  flyctl apps create "$FLY_APP_NAME" --org personal
fi

# Update fly.toml's `app` field to match the env-configured name
sed -i.bak "s/^app = .*/app = \"$FLY_APP_NAME\"/" fly.toml
sed -i.bak "s/^primary_region = .*/primary_region = \"$FLY_REGION\"/" fly.toml
rm -f fly.toml.bak

# ── 2. Fly.io: push every secret ──────────────────────────────────────────
echo
echo "▶ Pushing secrets to Fly..."

# Derived URLs — the public hostnames Fly + Vercel allocate by default
PUBLIC_API_URL="https://${FLY_APP_NAME}.fly.dev"
FRONTEND_URL="https://${VERCEL_PROJECT_NAME}.vercel.app"

# `flyctl secrets set` accepts KEY=VALUE pairs; we pipe them all in one
# call so Fly only restarts the app once instead of per-secret.
flyctl secrets set \
  --app "$FLY_APP_NAME" \
  --stage \
  NODE_ENV=production \
  PORT=3001 \
  TRUST_PROXY_HOPS=1 \
  PUBLIC_API_URL="$PUBLIC_API_URL" \
  FRONTEND_URL="$FRONTEND_URL" \
  IMPERSONATION_HMAC_SECRET="$IMPERSONATION_HMAC_SECRET" \
  OAUTH_STATE_SECRET="$OAUTH_STATE_SECRET" \
  ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  ALLOW_SMOKE_TEST=0 \
  WH_VERIFY_TOKEN="$WH_VERIFY_TOKEN" \
  META_VERIFY_TOKEN="$META_VERIFY_TOKEN" \
  META_APP_ID="$META_APP_ID" \
  META_APP_SECRET="$META_APP_SECRET" \
  META_REDIRECT_URI="$PUBLIC_API_URL/api/auth/instagram/callback" \
  GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  GOOGLE_REDIRECT_URI="$PUBLIC_API_URL/api/auth/google/callback" \
  GOOGLE_TOKEN_SECRET="$GOOGLE_TOKEN_SECRET" \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  LOG_AI_USAGE=0 \
  RAZORPAY_KEY_ID="$RAZORPAY_KEY_ID" \
  RAZORPAY_KEY_SECRET="$RAZORPAY_KEY_SECRET" \
  RAZORPAY_WEBHOOK_SECRET="$RAZORPAY_WEBHOOK_SECRET" \
  RESEND_API_KEY="$RESEND_API_KEY" \
  RESEND_FROM_EMAIL="$RESEND_FROM_EMAIL" \
  REDIS_URL="$REDIS_URL" \
  WORKFLOW_CONCURRENCY=10 \
  MESSAGE_CONCURRENCY=5 \
  BROADCAST_CONCURRENCY=3 \
  IDEMPOTENCY_RETENTION_HOURS=24 \
  DISABLE_WORKERS=1

# Per-process override: worker process should NOT have DISABLE_WORKERS=1
# (it's the queue consumer). Fly secrets are app-wide so we use a process-
# scoped override via [env] in fly.toml. The web process inherits 1; the
# worker reads the override.
echo "  Set DISABLE_WORKERS=0 specifically for worker process via fly.toml [env.worker]..."
# (This was already configured in fly.toml at write time.)

# Optional connector secrets — only set if filled
if [ -n "${AIRTABLE_CLIENT_ID:-}" ]; then
  flyctl secrets set --app "$FLY_APP_NAME" --stage \
    AIRTABLE_CLIENT_ID="$AIRTABLE_CLIENT_ID" \
    AIRTABLE_REDIRECT_URI="$PUBLIC_API_URL/api/auth/airtable/callback"
fi
if [ -n "${SHOPIFY_API_KEY:-}" ]; then
  flyctl secrets set --app "$FLY_APP_NAME" --stage \
    SHOPIFY_API_KEY="$SHOPIFY_API_KEY" \
    SHOPIFY_API_SECRET="$SHOPIFY_API_SECRET" \
    SHOPIFY_REDIRECT_URI="$PUBLIC_API_URL/api/auth/shopify/callback"
fi

echo "  ✓ Secrets staged (will activate on next deploy)"

# ── 3. Fly.io: deploy ──────────────────────────────────────────────────────
echo
echo "▶ Deploying to Fly.io (this builds the Docker image; ~3-5 min)..."
flyctl deploy --app "$FLY_APP_NAME" --remote-only

echo
echo "  ✓ Server live at: $PUBLIC_API_URL"
echo "    Health check: $PUBLIC_API_URL/health"

# ── 4. Vercel: link + deploy FE ───────────────────────────────────────────
echo
echo "▶ Vercel setup (frontend)"

FE_DIR="${REPO_ROOT}/../flowgpt/.claude/worktrees/mystifying-dhawan-5252d2"
if [ ! -d "$FE_DIR" ]; then
  echo "❌ FE worktree not found at: $FE_DIR"
  echo "  Edit this script to set FE_DIR to your frontend repo path."
  exit 1
fi

# Vercel CLI needs auth — surface the error early
if ! vercel whoami &> /dev/null; then
  echo "❌ vercel not authenticated. Run: vercel login"
  exit 1
fi
VERCEL_USER=$(vercel whoami)
echo "  ✓ vercel authed as: $VERCEL_USER"

cd "$FE_DIR"

# Set env vars on Vercel (production scope)
# `vercel env add` is interactive; use `printf VALUE | vercel env add` to pipe.
echo "  Setting Vercel env vars..."
echo "$PUBLIC_API_URL" | vercel env add VITE_API_URL production --force 2>&1 | tail -1
echo "$SUPABASE_URL" | vercel env add VITE_SUPABASE_URL production --force 2>&1 | tail -1
echo "$SUPABASE_ANON_KEY" | vercel env add VITE_SUPABASE_ANON_KEY production --force 2>&1 | tail -1
if [ -n "${RAZORPAY_KEY_ID:-}" ]; then
  echo "$RAZORPAY_KEY_ID" | vercel env add VITE_RAZORPAY_KEY_ID production --force 2>&1 | tail -1
fi

echo "  Deploying to Vercel production..."
VERCEL_DEPLOY_OUTPUT=$(vercel --prod --yes 2>&1)
echo "$VERCEL_DEPLOY_OUTPUT" | tail -10
VERCEL_URL=$(echo "$VERCEL_DEPLOY_OUTPUT" | grep -o 'https://[^[:space:]]*\.vercel\.app' | head -1)

cd "$REPO_ROOT"

# ── 5. Final summary ──────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  🟢 DEPLOY COMPLETE"
echo "═══════════════════════════════════════════════════════════════════"
echo
echo "  Backend (Fly.io): $PUBLIC_API_URL"
echo "  Frontend (Vercel): ${VERCEL_URL:-$FRONTEND_URL}"
echo
echo "  Next steps (manual, one-time):"
echo
echo "  1. SUPABASE MIGRATIONS — apply schema to prod:"
echo "       cd $REPO_ROOT"
echo "       supabase db push --linked"
echo "     ⚠ Migration 053 uses CREATE INDEX CONCURRENTLY and cannot run"
echo "       inside a transaction. If supabase db push wraps it, apply"
echo "       manually:  psql \$SUPABASE_DB_URL -f supabase/migrations/053_fk_indexes.sql"
echo
echo "  2. AES TOKEN REWRAP (only if migrating from a prior CBC deploy):"
echo "       fly ssh console --app $FLY_APP_NAME"
echo "       node dist/scripts/rewrap-tokens.js"
echo
echo "  3. WEBHOOK URLS — update in each provider's dashboard:"
echo "       Meta WhatsApp:    $PUBLIC_API_URL/webhook/whatsapp   (verify token: WH_VERIFY_TOKEN value above)"
echo "       Meta Instagram:   $PUBLIC_API_URL/webhook/instagram  (verify token: META_VERIFY_TOKEN value above)"
echo "       Razorpay:         $PUBLIC_API_URL/api/billing/razorpay/webhook (set webhook secret to RAZORPAY_WEBHOOK_SECRET)"
echo "       Telegram:         per-tenant; setWebhook is called automatically when each bot first connects"
echo
echo "  4. OAUTH REDIRECT URIs — add to each provider's allowlist:"
echo "       Google: $PUBLIC_API_URL/api/auth/google/callback"
echo "       Meta:   $PUBLIC_API_URL/api/auth/instagram/callback"
echo "       Razorpay (if Partner OAuth): $PUBLIC_API_URL/api/auth/razorpay/callback"
echo
echo "  5. CUSTOM DOMAIN (optional):"
echo "       fly certs add api.frequency.in --app $FLY_APP_NAME"
echo "       vercel domains add app.frequency.in"
echo
