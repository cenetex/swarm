#!/bin/bash
#
# Stripe Product & Price Setup
#
# Creates Swarm products (Free/Pro/Enterprise) and their monthly prices.
# Idempotent: checks for existing products by metadata.plan_type before creating.
#
# Usage:
#   ./stripe/scripts/setup-products.sh          # Test mode (default)
#   ./stripe/scripts/setup-products.sh --live    # Live mode (requires confirmation)
#
# Prerequisites:
#   - stripe CLI installed and authenticated (stripe login)
#   - jq installed
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${SCRIPT_DIR}/../config"
PRODUCTS_JSON="${CONFIG_DIR}/products.json"

# Parse mode
MODE="test"
STRIPE_FLAGS=""
if [[ "${1:-}" == "--live" ]]; then
  MODE="live"
  STRIPE_FLAGS="--live"
fi

OUTPUT_FILE="${CONFIG_DIR}/stripe-ids.${MODE}.json"

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║             Stripe Product & Price Setup                      ║"
echo "║                    Mode: ${MODE}                                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check prerequisites
if ! command -v stripe &>/dev/null; then
  echo -e "${RED}Error: stripe CLI not found. Install with: brew install stripe/stripe-cli/stripe${NC}"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo -e "${RED}Error: jq not found. Install with: brew install jq${NC}"
  exit 1
fi

if [[ ! -f "$PRODUCTS_JSON" ]]; then
  echo -e "${RED}Error: products.json not found at ${PRODUCTS_JSON}${NC}"
  exit 1
fi

# Show current account
echo -e "${BLUE}Stripe account:${NC}"
stripe config --list $STRIPE_FLAGS 2>/dev/null | head -5 || true
echo ""

# Live mode confirmation
if [[ "$MODE" == "live" ]]; then
  echo -e "${RED}WARNING: You are about to create products in LIVE mode.${NC}"
  read -p "Type 'yes' to continue: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

# Initialize output JSON
OUTPUT_JSON=$(jq -n \
  --arg mode "$MODE" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    _mode: $mode,
    _created_at: $ts,
    products: {},
    metered_prices: {}
  }')

# Helper: create or find a product by plan_type
# Returns product ID on stdout; informational messages go to stderr.
create_or_find_product() {
  local plan_type="$1"
  local name="$2"
  local description="$3"
  shift 3
  local metadata_args=("$@")

  echo -e "${BLUE}[$plan_type]${NC} Checking for existing product..." >&2

  # Search by metadata
  local existing
  existing=$(stripe products search \
    --query "metadata['plan_type']:'${plan_type}'" \
    $STRIPE_FLAGS \
    -d limit=1 2>&1 | jq -r '.data[0].id // empty') || existing=""

  if [[ -n "$existing" ]]; then
    echo -e "  ${YELLOW}Already exists: ${existing}${NC}" >&2
    echo "$existing"
    return
  fi

  echo -e "  Creating product..." >&2
  local result
  # Convert --metadata key=val args to -d metadata[key]=val for Stripe CLI
  local converted_args=()
  local i=0
  while [[ $i -lt ${#metadata_args[@]} ]]; do
    local arg="${metadata_args[$i]}"
    if [[ "$arg" == "--metadata" ]]; then
      i=$((i + 1))
      local kv="${metadata_args[$i]}"
      local key="${kv%%=*}"
      local val="${kv#*=}"
      converted_args+=(-d "metadata[${key}]=${val}")
    else
      converted_args+=("$arg")
    fi
    i=$((i + 1))
  done
  if ! result=$(stripe products create \
    --name "$name" \
    --description "$description" \
    "${converted_args[@]}" \
    $STRIPE_FLAGS 2>&1); then
    echo -e "  ${RED}Failed to create product: ${result}${NC}" >&2
    exit 1
  fi

  local product_id
  product_id=$(echo "$result" | jq -r '.id')
  if [[ -z "$product_id" || "$product_id" == "null" ]]; then
    echo -e "  ${RED}Failed to parse product ID from response${NC}" >&2
    exit 1
  fi
  echo -e "  ${GREEN}Created: ${product_id}${NC}" >&2
  echo "$product_id"
}

# Helper: create a monthly recurring price
# Returns price ID on stdout; informational messages go to stderr.
create_price() {
  local product_id="$1"
  local amount_cents="$2"
  local plan_type="$3"

  echo -e "  Creating \$$(echo "scale=2; $amount_cents / 100" | bc)/mo price..." >&2

  local result
  if ! result=$(stripe prices create \
    --product "$product_id" \
    --currency usd \
    --unit-amount "$amount_cents" \
    -d "recurring[interval]=month" \
    -d "metadata[plan_type]=${plan_type}" \
    $STRIPE_FLAGS 2>&1); then
    echo -e "  ${RED}Failed to create price: ${result}${NC}" >&2
    exit 1
  fi

  local price_id
  price_id=$(echo "$result" | jq -r '.id')
  if [[ -z "$price_id" || "$price_id" == "null" ]]; then
    echo -e "  ${RED}Failed to parse price ID from response${NC}" >&2
    exit 1
  fi
  echo -e "  ${GREEN}Price: ${price_id}${NC}" >&2
  echo "$price_id"
}

# Helper: find existing active price for a product
find_existing_price() {
  local product_id="$1"

  local existing
  existing=$(stripe prices list \
    -d product="$product_id" \
    -d active=true \
    -d "recurring[interval]=month" \
    -d limit=1 \
    $STRIPE_FLAGS 2>&1 | jq -r '.data[0].id // empty') || existing=""

  echo "$existing"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Creating products and prices...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# --- Free tier ---
FREE_PRODUCT_ID=$(create_or_find_product "free" \
  "Swarm Free" \
  "Get started with your AI avatar on one platform. Includes 50 messages/day, 5 media credits, 2 voice minutes, and up to 3 tool calls per message. Stateless — no persistent memory. Orb holders automatically receive boosted limits." \
  --metadata plan_type=free \
  --metadata daily_message_limit=50 \
  --metadata daily_media_credits=5 \
  --metadata daily_voice_minutes=2 \
  --metadata max_tool_calls_per_message=3 \
  --metadata max_platforms=1 \
  --metadata max_channels=2 \
  --metadata memory_enabled=false \
  --metadata autonomous_posts_enabled=false)

FREE_PRICE_ID=$(find_existing_price "$FREE_PRODUCT_ID")
if [[ -z "$FREE_PRICE_ID" ]]; then
  FREE_PRICE_ID=$(create_price "$FREE_PRODUCT_ID" 0 "free")
else
  echo -e "  ${YELLOW}Price already exists: ${FREE_PRICE_ID}${NC}"
fi
echo ""

# --- Pro tier ---
PRO_PRODUCT_ID=$(create_or_find_product "pro" \
  "Swarm Pro" \
  "Unlock your avatar's full potential. 500 messages/day, 50 media credits, 30 voice minutes, persistent memory (30-day retention), autonomous posting, custom model selection, and multi-platform support across up to 3 platforms and 10 channels." \
  --metadata plan_type=pro \
  --metadata daily_message_limit=500 \
  --metadata daily_media_credits=50 \
  --metadata daily_voice_minutes=30 \
  --metadata max_tool_calls_per_message=5 \
  --metadata max_platforms=3 \
  --metadata max_channels=10 \
  --metadata memory_enabled=true \
  --metadata memory_retention_days=30 \
  --metadata max_memories_per_tier=100 \
  --metadata autonomous_posts_enabled=true \
  --metadata custom_model_enabled=true)

PRO_PRICE_ID=$(find_existing_price "$PRO_PRODUCT_ID")
if [[ -z "$PRO_PRICE_ID" ]]; then
  PRO_PRICE_ID=$(create_price "$PRO_PRODUCT_ID" 900 "pro")
else
  echo -e "  ${YELLOW}Price already exists: ${PRO_PRICE_ID}${NC}"
fi
echo ""

# --- Enterprise tier ---
ENT_PRODUCT_ID=$(create_or_find_product "enterprise" \
  "Swarm Enterprise" \
  "Unlimited messaging, media, and voice for production-grade avatars. Priority processing, unlimited platforms and channels, 365-day memory retention, autonomous posting, custom models, and 10 tool calls per message. Built for teams running avatars at scale." \
  --metadata plan_type=enterprise \
  --metadata daily_message_limit=-1 \
  --metadata daily_media_credits=-1 \
  --metadata daily_voice_minutes=-1 \
  --metadata max_tool_calls_per_message=10 \
  --metadata max_platforms=-1 \
  --metadata max_channels=-1 \
  --metadata memory_enabled=true \
  --metadata memory_retention_days=365 \
  --metadata max_memories_per_tier=1000 \
  --metadata autonomous_posts_enabled=true \
  --metadata custom_model_enabled=true \
  --metadata priority_processing=true)

ENT_PRICE_ID=$(find_existing_price "$ENT_PRODUCT_ID")
if [[ -z "$ENT_PRICE_ID" ]]; then
  ENT_PRICE_ID=$(create_price "$ENT_PRODUCT_ID" 2900 "enterprise")
else
  echo -e "  ${YELLOW}Price already exists: ${ENT_PRICE_ID}${NC}"
fi
echo ""

# --- Write output ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Writing config to ${OUTPUT_FILE}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

OUTPUT_JSON=$(echo "$OUTPUT_JSON" | jq \
  --arg fp "$FREE_PRODUCT_ID" --arg fpr "$FREE_PRICE_ID" \
  --arg pp "$PRO_PRODUCT_ID" --arg ppr "$PRO_PRICE_ID" \
  --arg ep "$ENT_PRODUCT_ID" --arg epr "$ENT_PRICE_ID" \
  '.products.free = { product_id: $fp, price_id: $fpr } |
   .products.pro = { product_id: $pp, price_id: $ppr } |
   .products.enterprise = { product_id: $ep, price_id: $epr }')

echo "$OUTPUT_JSON" | jq '.' > "$OUTPUT_FILE"

echo ""
echo -e "${GREEN}Done! Products and prices created.${NC}"
echo ""
echo "  Free:       product=$FREE_PRODUCT_ID  price=$FREE_PRICE_ID"
echo "  Pro:        product=$PRO_PRODUCT_ID  price=$PRO_PRICE_ID"
echo "  Enterprise: product=$ENT_PRODUCT_ID  price=$ENT_PRICE_ID"
echo ""
echo -e "Config saved to: ${BLUE}${OUTPUT_FILE}${NC}"
echo ""
echo -e "${YELLOW}Next: run ./stripe/scripts/setup-metered-prices.sh to add overage pricing${NC}"
