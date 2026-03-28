#!/bin/bash
# Fresh production deploy — recreates all infrastructure and deploys all workers.
# Secrets are preserved (they survive re-deployments on Cloudflare).
# Run: bash scripts/fresh-deploy.sh
set -euo pipefail

CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_DIR="$CORE_DIR/../clopinette-platform"
GATEWAY_DIR="$PLATFORM_DIR/packages/gateway"

if [ ! -d "$GATEWAY_DIR" ]; then
  echo "ERROR: Gateway dir not found at $GATEWAY_DIR"
  echo "Expected repo layout: clopinette-ai-dev/ + clopinette-platform/ side by side"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     ClopinetteAI — Fresh Production Deploy   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── 1. R2 Buckets ───
echo "=== 1/8 Creating R2 buckets ==="
wrangler r2 bucket create clopinette-memories 2>/dev/null && echo "  Created clopinette-memories" || echo "  clopinette-memories already exists"
wrangler r2 bucket create clopinette-skills 2>/dev/null && echo "  Created clopinette-skills" || echo "  clopinette-skills already exists"

# ─── 2. KV Namespace ───
echo ""
echo "=== 2/8 Creating KV namespace ==="
KV_OUTPUT=$(wrangler kv namespace create LINKS 2>&1 || true)
KV_ID=$(echo "$KV_OUTPUT" | grep -oP '[a-f0-9]{32}' | head -1 || true)
if [ -n "$KV_ID" ]; then
  echo "  New KV namespace ID: $KV_ID"
  # Update BOTH wrangler.jsonc files (core + gateway share the same KV)
  sed -i "s/\"id\": \"[a-f0-9]\{32\}\"/\"id\": \"$KV_ID\"/" "$CORE_DIR/wrangler.jsonc"
  sed -i "s/\"id\": \"[a-f0-9]\{32\}\"/\"id\": \"$KV_ID\"/" "$GATEWAY_DIR/wrangler.jsonc"
  echo "  Updated both wrangler.jsonc files"
else
  echo "  KV namespace already exists — keeping current ID"
fi

# ─── 3. D1 Database ───
echo ""
echo "=== 3/8 Creating D1 database ==="
D1_OUTPUT=$(wrangler d1 create clopinette-db 2>&1 || true)
D1_ID=$(echo "$D1_OUTPUT" | grep -oP '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1 || true)
if [ -n "$D1_ID" ]; then
  echo "  New D1 database ID: $D1_ID"
  sed -i "s/\"database_id\": \"[a-f0-9-]\{36\}\"/\"database_id\": \"$D1_ID\"/" "$GATEWAY_DIR/wrangler.jsonc"
  echo "  Updated gateway wrangler.jsonc"
else
  echo "  D1 database already exists — keeping current ID"
fi

# ─── 4. D1 Schema ───
echo ""
echo "=== 4/8 Applying D1 schema ==="
cd "$GATEWAY_DIR"
npx wrangler d1 execute clopinette-db --remote --file=migrations/0001_init.sql 2>&1 | tail -3
echo "  Schema applied"

# ─── 5. Deploy outbound worker ───
echo ""
echo "=== 5/8 Deploying outbound worker ==="
cd "$CORE_DIR/workers/outbound"
npx wrangler deploy 2>&1 | tail -3

# ─── 6. Deploy core worker ───
echo ""
echo "=== 6/8 Deploying core worker ==="
cd "$CORE_DIR"
bun run deploy 2>&1 | tail -3

# ─── 7. Deploy gateway worker ───
echo ""
echo "=== 7/8 Deploying gateway worker ==="
cd "$GATEWAY_DIR"
npx wrangler deploy 2>&1 | tail -3

# ─── 8. Register Telegram webhook ───
echo ""
echo "=== 8/8 Registering Telegram webhook ==="
API_KEY="${API_AUTH_KEY:-}"
if [ -n "$API_KEY" ]; then
  curl -s -X POST "https://agent.clopinette.app/api/admin/setup-telegram" \
    -H "Authorization: Bearer $API_KEY"
  echo ""
else
  echo "  Skipped — set API_AUTH_KEY env var to auto-register"
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║              Deploy complete!                 ║"
echo "║                                              ║"
echo "║  Core:    agent.clopinette.app               ║"
echo "║  Gateway: api.clopinette.app                 ║"
echo "║  Web:     clopinette.app                     ║"
echo "║                                              ║"
echo "║  Secrets are preserved across deploys.       ║"
echo "║  First time? Run: scripts/setup-secrets.sh   ║"
echo "╚══════════════════════════════════════════════╝"
