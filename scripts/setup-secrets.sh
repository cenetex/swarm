#!/bin/bash
#
# AWS Secrets Manager Setup Script
# Interactively creates/updates secrets needed for Swarm deployment
#
# Usage: ./scripts/setup-secrets.sh [environment]
# Example: ./scripts/setup-secrets.sh staging
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default environment
ENV="${1:-staging}"
PREFIX="swarm"

# CDK context/private config (used for prompting settings + writing secret ARNs)
# Keep this out of git; see packages/infra/cdk.context.example.json
CDK_CONTEXT_JSON="packages/infra/cdk.context.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_CONTEXT_JSON_PATH="${SCRIPT_DIR}/../${CDK_CONTEXT_JSON}"

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           AWS Secrets Manager Setup for Swarm                  ║"
echo "║                  Environment: ${ENV}                              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check AWS CLI is configured
if ! aws sts get-caller-identity &>/dev/null; then
    echo -e "${RED}Error: AWS CLI not configured or no valid credentials${NC}"
    echo "Please run 'aws configure' or set AWS_PROFILE"
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "us-east-1")

echo -e "${GREEN}AWS Account: ${ACCOUNT_ID}${NC}"
echo -e "${GREEN}Region: ${REGION}${NC}"
echo ""

# Function to create or update a secret
secret_exists() {
    local full_name="$1"
    aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null
}

prompt_secret_value() {
    local scope="$1" # env|global
    local name="$2"
    local description="$3"
    local help_url="$4"
    local is_json="${5:-false}"
    local mode="$6" # missing|existing
    local is_multiline="${7:-false}"

    local full_name=""
    if [ "$scope" = "global" ]; then
        full_name="${PREFIX}/global/${name}"
    else
        full_name="${PREFIX}/${ENV}/${name}"
    fi

    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    if [ "$scope" = "global" ]; then
        echo -e "${BLUE}Secret: ${full_name} (GLOBAL)${NC}"
    else
        echo -e "${BLUE}Secret: ${full_name}${NC}"
    fi
    echo -e "Description: ${description}"
    if [ -n "$help_url" ]; then
        echo -e "Get it from: ${help_url}"
    fi

    # Special case: make Twitter credentials easy to enter without manual JSON.
    # Stored as JSON in Secrets Manager: {"consumer_key":"...","consumer_secret":"..."}
    if [ "$scope" = "global" ] && [ "$name" = "twitter-app-credentials" ] && [ "$is_json" = "true" ]; then
        local existing_json=""
        local existing_consumer_key=""
        local existing_consumer_secret=""

        if [ "$mode" != "missing" ]; then
            if aws secretsmanager get-secret-value --secret-id "$full_name" --query SecretString --output text &>/dev/null 2>&1; then
                existing_json=$(aws secretsmanager get-secret-value --secret-id "$full_name" --query SecretString --output text 2>/dev/null || echo "")
                if [ -n "$existing_json" ]; then
                    existing_consumer_key=$(node -e "try{const o=JSON.parse(process.argv[1]);process.stdout.write(o.consumer_key||'')}catch(e){}" "$existing_json" 2>/dev/null || true)
                    existing_consumer_secret=$(node -e "try{const o=JSON.parse(process.argv[1]);process.stdout.write(o.consumer_secret||'')}catch(e){}" "$existing_json" 2>/dev/null || true)
                fi
            fi
        fi

        if [ "$mode" = "missing" ]; then
            echo -e "${YELLOW}Current status: Not set${NC}"
        else
            echo -e "${GREEN}Current status: Set${NC}"
            read -p "Update this secret? [y/N]: " choice
            case "$choice" in
                [yY]|[yY][eE][sS])
                    ;;
                *)
                    echo -e "${YELLOW}Skipped${NC}"
                    echo ""
                    return
                    ;;
            esac
        fi

        echo ""
        if [ "$mode" = "missing" ]; then
            read -sp "Enter Twitter consumer_key (press Enter to skip): " consumer_key
            echo ""
            read -sp "Enter Twitter consumer_secret (press Enter to skip): " consumer_secret
            echo ""
        else
            read -sp "Enter Twitter consumer_key (press Enter to keep existing): " consumer_key
            echo ""
            read -sp "Enter Twitter consumer_secret (press Enter to keep existing): " consumer_secret
            echo ""
        fi

        # For existing secrets, allow pressing Enter to keep current values.
        if [ "$mode" != "missing" ]; then
            [ -z "$consumer_key" ] && consumer_key="$existing_consumer_key"
            [ -z "$consumer_secret" ] && consumer_secret="$existing_consumer_secret"
        fi

        if [ -z "$consumer_key" ] || [ -z "$consumer_secret" ]; then
            echo -e "${YELLOW}Skipped (both consumer_key and consumer_secret are required)${NC}"
            echo ""
            return
        fi

        value=$(node -e "const ck=process.argv[1]; const cs=process.argv[2]; process.stdout.write(JSON.stringify({consumer_key: ck, consumer_secret: cs}));" "$consumer_key" "$consumer_secret")

        if [ "$mode" = "missing" ]; then
            aws secretsmanager create-secret \
                --name "$full_name" \
                --description "$description" \
                --secret-string "$value" \
                --output text > /dev/null
            echo -e "${GREEN}✓ Secret created${NC}"
            echo ""
            return
        fi

        aws secretsmanager put-secret-value \
            --secret-id "$full_name" \
            --secret-string "$value" \
            --output text > /dev/null
        echo -e "${GREEN}✓ Secret updated${NC}"
        echo ""
        return
    fi

    if [ "$mode" = "missing" ]; then
        echo -e "${YELLOW}Current status: Not set${NC}"
        echo ""
        if [ "$is_json" = "true" ] || [ "$is_multiline" = "true" ]; then
            if [ "$is_json" = "true" ]; then
                echo "Enter JSON value (paste and press Enter, then Ctrl+D)."
            else
                echo "Enter value (paste and press Enter, then Ctrl+D)."
            fi
            value=$(cat)
        else
            read -sp "Enter value (or press Enter to skip): " value
            echo ""
        fi

        if [ -z "$value" ]; then
            echo -e "${YELLOW}Skipped${NC}"
            echo ""
            return
        fi

        aws secretsmanager create-secret \
            --name "$full_name" \
            --description "$description" \
            --secret-string "$value" \
            --output text > /dev/null
        echo -e "${GREEN}✓ Secret created${NC}"
        echo ""
        return
    fi

    echo -e "${GREEN}Current status: Set${NC}"
    read -p "Update this secret? [y/N]: " choice

    case "$choice" in
        [yY]|[yY][eE][sS])
            echo ""
            if [ "$is_json" = "true" ] || [ "$is_multiline" = "true" ]; then
                if [ "$is_json" = "true" ]; then
                    echo "Enter JSON value (paste and press Enter, then Ctrl+D)."
                else
                    echo "Enter value (paste and press Enter, then Ctrl+D)."
                fi
                value=$(cat)
            else
                read -sp "Enter new value (or press Enter to skip): " value
                echo ""
            fi

            if [ -z "$value" ]; then
                echo -e "${YELLOW}Skipped${NC}"
                echo ""
                return
            fi

            aws secretsmanager put-secret-value \
                --secret-id "$full_name" \
                --secret-string "$value" \
                --output text > /dev/null
            echo -e "${GREEN}✓ Secret updated${NC}"
            ;;
        *)
            echo -e "${YELLOW}Skipped${NC}"
            ;;
    esac

    echo ""
}

prompt_cdk_string_setting() {
    local key="$1"
    local description="$2"
    local help_url="$3"
    local mode="$4" # missing|existing

    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}CDK Setting: environments.${ENV}.${key}${NC}"
    echo -e "Description: ${description}"
    if [ -n "$help_url" ]; then
        echo -e "Get it from: ${help_url}"
    fi

    if [ "$mode" = "existing" ]; then
        read -p "Update this value? [y/N]: " choice
        case "$choice" in
            [yY]|[yY][eE][sS])
                ;;
            *)
                echo -e "${YELLOW}Skipped${NC}"
                echo ""
                return
                ;;
        esac
    fi

    echo ""
    read -p "Enter value (or press Enter to skip): " value

    if [ -z "$value" ]; then
        echo -e "${YELLOW}Skipped${NC}"
        echo ""
        return
    fi

    if [ ! -f "$CDK_CONTEXT_JSON_PATH" ]; then
        echo "{}" > "$CDK_CONTEXT_JSON_PATH"
    fi

    # Write via Node for portability + safe quoting.
    node - "$CDK_CONTEXT_JSON_PATH" "$ENV" "$key" "$value" <<'NODE'
const fs = require('fs');

const [,, path, env, key, value] = process.argv;
const config = JSON.parse(fs.readFileSync(path, 'utf8'));

if (!config.environments) config.environments = {};
if (!config.environments[env]) config.environments[env] = {};

config.environments[env][key] = value;
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
NODE

    echo -e "${GREEN}✓ Updated ${CDK_CONTEXT_JSON} (${key})${NC}"
    echo ""
}

ENV_SECRET_NAMES=(
    "openrouter-api-key"
    "helius-api-key"
    "replicate-api-key"
    "web-search-api-key"
    "privy-app-secret"
    "privy-jwt-verification-key"
)

ENV_SECRET_DESCRIPTIONS=(
    "OpenRouter API key for server-side LLM, image, and video access"
    "Helius API key for Solana RPC and NFT queries"
    "Replicate API key for AI voice/audio generation"
    "SerpAPI key for web search functionality"
    "Privy app secret (server-side API access)"
    "Privy JWT verification key (verify access tokens server-side)"
)

ENV_SECRET_URLS=(
    "https://openrouter.ai/keys"
    "https://dev.helius.xyz/dashboard/app"
    "https://replicate.com/account/api-tokens"
    "https://serpapi.com/manage-api-key"
    "https://dashboard.privy.io"
    "https://dashboard.privy.io"
)

# Some secrets are easiest to paste as multi-line (e.g. PEM/JWK material)
ENV_SECRET_IS_MULTILINE=(false false false false false true)

# 0 = required, 1 = optional
ENV_SECRET_OPTIONAL=(0 0 1 1 1 1)

GLOBAL_SECRET_NAMES=("twitter-app-credentials")
GLOBAL_SECRET_DESCRIPTIONS=("Twitter/X OAuth app credentials")
GLOBAL_SECRET_URLS=("https://developer.twitter.com/en/portal/dashboard")
GLOBAL_SECRET_IS_JSON=("true")

echo -e "${BLUE}=== Step 1: Request UNSET secrets ===${NC}"
echo ""

echo -e "${YELLOW}Environment secrets (${ENV})${NC}"
for i in "${!ENV_SECRET_NAMES[@]}"; do
    name="${ENV_SECRET_NAMES[$i]}"
    full_name="${PREFIX}/${ENV}/${name}"
    if ! secret_exists "$full_name"; then
        prompt_secret_value "env" "$name" "${ENV_SECRET_DESCRIPTIONS[$i]}" "${ENV_SECRET_URLS[$i]}" "false" "missing" "${ENV_SECRET_IS_MULTILINE[$i]}"
    fi
done

echo -e "${YELLOW}Global secrets${NC}"
for i in "${!GLOBAL_SECRET_NAMES[@]}"; do
    name="${GLOBAL_SECRET_NAMES[$i]}"
    full_name="${PREFIX}/global/${name}"
    if ! secret_exists "$full_name"; then
        prompt_secret_value "global" "$name" "${GLOBAL_SECRET_DESCRIPTIONS[$i]}" "${GLOBAL_SECRET_URLS[$i]}" "${GLOBAL_SECRET_IS_JSON[$i]}" "missing"
    fi
done

echo -e "${BLUE}=== Step 2: Request UNSET CDK settings ===${NC}"
echo ""

if [ ! -f "$CDK_CONTEXT_JSON_PATH" ]; then
    echo "{}" > "$CDK_CONTEXT_JSON_PATH"
fi

if [ -f "$CDK_CONTEXT_JSON_PATH" ]; then
    existing_privy_app_id=""
    if command -v jq &>/dev/null; then
        existing_privy_app_id=$(jq -r ".environments.${ENV}.privyAppId // \"\"" "$CDK_CONTEXT_JSON_PATH")
    else
        existing_privy_app_id=$(node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('${CDK_CONTEXT_JSON_PATH}','utf8'));
console.log((cfg.environments && cfg.environments['${ENV}'] && cfg.environments['${ENV}'].privyAppId) || '');
")
    fi

    if [ -z "$existing_privy_app_id" ]; then
        prompt_cdk_string_setting \
            "privyAppId" \
            "Privy App ID (non-secret, required for Privy auth endpoints)" \
            "https://dashboard.privy.io" \
            "missing"
    fi
else
    echo -e "${YELLOW}Warning: ${CDK_CONTEXT_JSON} not found; will skip CDK setting prompts.${NC}"
    echo ""
fi

echo -e "${BLUE}=== Step 3: Request ALREADY-SET secrets (optional updates) ===${NC}"
echo ""

echo -e "${YELLOW}Environment secrets (${ENV})${NC}"
for i in "${!ENV_SECRET_NAMES[@]}"; do
    name="${ENV_SECRET_NAMES[$i]}"
    full_name="${PREFIX}/${ENV}/${name}"
    if secret_exists "$full_name"; then
        prompt_secret_value "env" "$name" "${ENV_SECRET_DESCRIPTIONS[$i]}" "${ENV_SECRET_URLS[$i]}" "false" "existing" "${ENV_SECRET_IS_MULTILINE[$i]}"
    fi
done

echo -e "${YELLOW}Global secrets${NC}"
for i in "${!GLOBAL_SECRET_NAMES[@]}"; do
    name="${GLOBAL_SECRET_NAMES[$i]}"
    full_name="${PREFIX}/global/${name}"
    if secret_exists "$full_name"; then
        prompt_secret_value "global" "$name" "${GLOBAL_SECRET_DESCRIPTIONS[$i]}" "${GLOBAL_SECRET_URLS[$i]}" "${GLOBAL_SECRET_IS_JSON[$i]}" "existing"
    fi
done

echo -e "${BLUE}=== Step 4: Request ALREADY-SET CDK settings (optional updates) ===${NC}"
echo ""

if [ ! -f "$CDK_CONTEXT_JSON_PATH" ]; then
    echo "{}" > "$CDK_CONTEXT_JSON_PATH"
fi

if [ -f "$CDK_CONTEXT_JSON_PATH" ]; then
    existing_privy_app_id=""
    if command -v jq &>/dev/null; then
        existing_privy_app_id=$(jq -r ".environments.${ENV}.privyAppId // \"\"" "$CDK_CONTEXT_JSON_PATH")
    else
        existing_privy_app_id=$(node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('${CDK_CONTEXT_JSON_PATH}','utf8'));
console.log((cfg.environments && cfg.environments['${ENV}'] && cfg.environments['${ENV}'].privyAppId) || '');
")
    fi

    if [ -n "$existing_privy_app_id" ]; then
        prompt_cdk_string_setting \
            "privyAppId" \
            "Privy App ID (non-secret, required for Privy auth endpoints)" \
            "https://dashboard.privy.io" \
            "existing"
    fi
fi

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Setup Complete!                             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo "Secret ARNs for CDK configuration:"
echo ""

# List created secrets
echo -e "${GREEN}Environment secrets (${ENV}):${NC}"
for secret in openrouter-api-key helius-api-key replicate-api-key web-search-api-key privy-app-secret privy-jwt-verification-key; do
    full_name="${PREFIX}/${ENV}/${secret}"
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
        arn=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
        echo "  $secret:"
        echo "    $arn"
    fi
done

echo ""
echo -e "${GREEN}Global secrets:${NC}"
for secret in twitter-app-credentials; do
    full_name="${PREFIX}/global/${secret}"
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
        arn=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
        echo "  $secret:"
        echo "    $arn"
    fi
done

echo ""
echo -e "${BLUE}=== Updating CDK Configuration ===${NC}"
echo ""

if [ ! -f "$CDK_CONTEXT_JSON_PATH" ]; then
    echo "{}" > "$CDK_CONTEXT_JSON_PATH"
fi

if [ -f "$CDK_CONTEXT_JSON_PATH" ]; then
    # Get ARNs for each secret
    OPENROUTER_ARN=""
    HELIUS_ARN=""
    REPLICATE_ARN=""
    WEBSEARCH_ARN=""
    PRIVY_APP_SECRET_ARN=""
    PRIVY_JWT_VERIFICATION_KEY_ARN=""
    TWITTER_ARN=""

    for secret in openrouter-api-key helius-api-key replicate-api-key web-search-api-key privy-app-secret privy-jwt-verification-key; do
        full_name="${PREFIX}/${ENV}/${secret}"
        if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
            arn=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
            case "$secret" in
                openrouter-api-key) OPENROUTER_ARN="$arn" ;;
                helius-api-key) HELIUS_ARN="$arn" ;;
                replicate-api-key) REPLICATE_ARN="$arn" ;;
                web-search-api-key) WEBSEARCH_ARN="$arn" ;;
                privy-app-secret) PRIVY_APP_SECRET_ARN="$arn" ;;
                privy-jwt-verification-key) PRIVY_JWT_VERIFICATION_KEY_ARN="$arn" ;;
            esac
        fi
    done

    # Get global Twitter credentials ARN
    full_name="${PREFIX}/global/twitter-app-credentials"
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
        TWITTER_ARN=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
    fi

    # Merge ARNs into cdk.context.json (keeps private config out of git)
    node - "$CDK_CONTEXT_JSON_PATH" "$ENV" \
        "$OPENROUTER_ARN" "$HELIUS_ARN" "$REPLICATE_ARN" "$WEBSEARCH_ARN" \
        "$PRIVY_APP_SECRET_ARN" "$PRIVY_JWT_VERIFICATION_KEY_ARN" \
        "$TWITTER_ARN" <<'NODE'
const fs = require('fs');

const [,, path, env,
  openRouterApiKeyArn,
  heliusApiKeyArn,
  replicateApiKeyArn,
  webSearchApiKeyArn,
  privyAppSecretArn,
  privyJwtVerificationKeyArn,
  twitterAppCredentialsArn,
] = process.argv;

const config = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!config.environments) config.environments = {};
if (!config.environments[env]) config.environments[env] = {};

const updates = {
  openRouterApiKeyArn,
  heliusApiKeyArn,
  replicateApiKeyArn,
  webSearchApiKeyArn,
  privyAppSecretArn,
  privyJwtVerificationKeyArn,
  twitterAppCredentialsArn,
};

for (const [k, v] of Object.entries(updates)) {
  if (v && v.trim()) config.environments[env][k] = v;
}

fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
NODE

    echo -e "${GREEN}✓ Updated ${CDK_CONTEXT_JSON} with secret ARNs for ${ENV}${NC}"
else
    echo -e "${YELLOW}Warning: ${CDK_CONTEXT_JSON} not found, skipping automatic update${NC}"
    echo "Please manually copy the ARNs above to your CDK configuration"
fi

echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Run 'pnpm -r build' to rebuild"
echo "2. Deploy with 'cd packages/infra && npx cdk deploy'"
echo ""
