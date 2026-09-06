#!/bin/bash
# One-time secrets setup. Run once, secrets persist across all re-deployments.
# Run: bash scripts/setup-secrets.sh
set -euo pipefail

CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_DIR="$CORE_DIR/../clopinette-platform"
GATEWAY_DIR="$PLATFORM_DIR/packages/gateway"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     ClopinetteAI — Secrets Setup (one-time)  ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Each secret will prompt for input. Press Ctrl+C to skip optional ones."
echo ""

# ─── Core worker secrets ───
echo "=== Core worker (clopinette-ai) ==="
cd "$CORE_DIR"

echo "--- Required ---"
echo "MASTER_KEY (generate with: openssl rand -base64 32)"
wrangler secret put MASTER_KEY
echo "CF_ACCOUNT_ID (Cloudflare dashboard → Account ID)"
wrangler secret put CF_ACCOUNT_ID
echo "CF_GATEWAY_ID (AI Gateway → Settings → Gateway ID)"
wrangler secret put CF_GATEWAY_ID
echo "WS_SIGNING_SECRET (generate with: openssl rand -base64 32) — MUST match gateway"
wrangler secret put WS_SIGNING_SECRET
echo "API_AUTH_KEY (any strong random string)"
wrangler secret put API_AUTH_KEY

echo ""
echo "--- Optional (press Ctrl+C to skip) ---"
echo "CF_BROWSER_TOKEN (Browser Rendering — for web tool: search, read, extract, crawl)"
wrangler secret put CF_BROWSER_TOKEN || true
echo "TELEGRAM_BOT_TOKEN (from @BotFather)"
wrangler secret put TELEGRAM_BOT_TOKEN || true
echo "GATEWAY_URL (e.g. https://api.clopinette.app)"
wrangler secret put GATEWAY_URL || true
echo "GATEWAY_INTERNAL_KEY (same as API_AUTH_KEY or separate)"
wrangler secret put GATEWAY_INTERNAL_KEY || true

# ─── Gateway worker secrets ───
echo ""
echo "=== Gateway worker (clopinette-gateway) ==="
cd "$GATEWAY_DIR"

echo "--- Required ---"
echo "CLERK_SECRET_KEY (Clerk dashboard → API Keys)"
wrangler secret put CLERK_SECRET_KEY
echo "CLERK_PUBLISHABLE_KEY"
wrangler secret put CLERK_PUBLISHABLE_KEY
echo "CLERK_WEBHOOK_SIGNING_SECRET (Clerk dashboard → Webhooks)"
wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET
echo "STRIPE_SECRET_KEY (Stripe dashboard → API Keys)"
wrangler secret put STRIPE_SECRET_KEY
echo "STRIPE_WEBHOOK_SECRET (Stripe dashboard → Webhooks)"
wrangler secret put STRIPE_WEBHOOK_SECRET
echo "STRIPE_PRICE_PRO (Stripe Price ID for Pro plan)"
wrangler secret put STRIPE_PRICE_PRO
echo "STRIPE_PRICE_BYOK (Stripe Price ID for BYOK plan)"
wrangler secret put STRIPE_PRICE_BYOK
echo "WS_SIGNING_SECRET — MUST be the same value as the core worker"
wrangler secret put WS_SIGNING_SECRET
echo "API_AUTH_KEY — MUST be the same value as the core worker"
wrangler secret put API_AUTH_KEY

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Secrets configured! Now run:                ║"
echo "║  bash scripts/fresh-deploy.sh                ║"
echo "╚══════════════════════════════════════════════╝"
