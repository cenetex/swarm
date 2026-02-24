#!/usr/bin/env bash
# Privileged Access Review Report
#
# Collects an inventory of privileged principals across GitHub, AWS, and
# application configuration, then produces a review evidence packet.
#
# Inventory sources:
#   1. GitHub collaborators and their roles
#   2. GitHub deploy keys
#   3. GitHub Actions environment secrets (names only)
#   4. ADMIN_EMAILS / ADMIN_WALLETS from CDK context
#   5. AWS IAM roles used by the project (if AWS credentials available)
#
# Usage:
#   ./scripts/access-review.sh                    # Human-readable markdown
#   ./scripts/access-review.sh --json             # Machine-readable JSON
#   ./scripts/access-review.sh --output-dir DIR   # Write evidence files to DIR
#
# Environment:
#   GH_TOKEN or GITHUB_TOKEN must be set (gh CLI auth)
#   AWS_REGION — optional; defaults to us-east-1
#   GITHUB_STEP_SUMMARY — if set, appends markdown to Actions job summary

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────
JSON_MODE=""
OUTPUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=1 ;;
    --output-dir)
      shift
      OUTPUT_DIR="$1"
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── Config ───────────────────────────────────────────────────────────────
REPO="${REPO:-cenetex/aws-swarm}"
AWS_REGION="${AWS_REGION:-us-east-1}"
REVIEW_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
REVIEW_QUARTER="Q$(( ($(date +%-m) - 1) / 3 + 1 )) $(date +%Y)"

# ── Helpers ──────────────────────────────────────────────────────────────
warn() { echo "WARN: $*" >&2; }

# ── 1. GitHub Collaborators ──────────────────────────────────────────────
echo "Collecting GitHub collaborators..." >&2
COLLABORATORS=$(gh api "repos/${REPO}/collaborators" \
  --jq '[.[] | {login: .login, role: .role_name, site_admin: .site_admin, permissions: .permissions}]' \
  2>/dev/null || echo '[]')

ADMIN_USERS=$(echo "$COLLABORATORS" | jq '[.[] | select(.role == "admin")]')
ADMIN_USER_COUNT=$(echo "$ADMIN_USERS" | jq 'length')
WRITE_USERS=$(echo "$COLLABORATORS" | jq '[.[] | select(.role == "write")]')
WRITE_USER_COUNT=$(echo "$WRITE_USERS" | jq 'length')
TOTAL_COLLABORATORS=$(echo "$COLLABORATORS" | jq 'length')

# ── 2. GitHub Teams (org repos) ─────────────────────────────────────────
echo "Collecting GitHub teams..." >&2
TEAMS=$(gh api "repos/${REPO}/teams" \
  --jq '[.[] | {name: .name, slug: .slug, permission: .permission}]' \
  2>/dev/null || echo '[]')

# ── 3. Deploy Keys ──────────────────────────────────────────────────────
echo "Collecting deploy keys..." >&2
DEPLOY_KEYS=$(gh api "repos/${REPO}/keys" \
  --jq '[.[] | {id: .id, title: .title, read_only: .read_only, created_at: .created_at}]' \
  2>/dev/null || echo '[]')
DEPLOY_KEY_COUNT=$(echo "$DEPLOY_KEYS" | jq 'length')

# ── 4. GitHub Actions Environments ───────────────────────────────────────
echo "Collecting GitHub environments..." >&2
ENVIRONMENTS=$(gh api "repos/${REPO}/environments" \
  --jq '[.environments[] | {name: .name, protection_rules: [.protection_rules[]? | {type: .type}], created_at: .created_at, updated_at: .updated_at}]' \
  2>/dev/null || echo '[]')

# ── 5. ADMIN_EMAILS / ADMIN_WALLETS from CDK context ────────────────────
echo "Collecting admin emails/wallets from CDK context..." >&2
ADMIN_EMAILS="[]"
ADMIN_WALLETS="[]"
CDK_CONTEXT_FILE=""

# Look for cdk.context.json in repo root
if [[ -f "cdk.context.json" ]]; then
  CDK_CONTEXT_FILE="cdk.context.json"
elif [[ -f "packages/infra/cdk.context.json" ]]; then
  CDK_CONTEXT_FILE="packages/infra/cdk.context.json"
fi

if [[ -n "$CDK_CONTEXT_FILE" ]]; then
  ADMIN_EMAILS=$(jq -r '
    [(.adminEmails // [])[], (.["staging:adminEmails"] // [])[], (.["production:adminEmails"] // [])[]]
    | unique' "$CDK_CONTEXT_FILE" 2>/dev/null || echo '[]')
  ADMIN_WALLETS=$(jq -r '
    [(.adminWallets // [])[], (.["staging:adminWallets"] // [])[], (.["production:adminWallets"] // [])[]]
    | unique' "$CDK_CONTEXT_FILE" 2>/dev/null || echo '[]')
fi

# ── 6. AWS IAM Roles (optional — requires AWS credentials) ──────────────
echo "Collecting AWS IAM roles..." >&2
AWS_AVAILABLE=false
IAM_ROLES="[]"
OIDC_PROVIDERS="[]"

if command -v aws &>/dev/null && aws sts get-caller-identity &>/dev/null 2>&1; then
  AWS_AVAILABLE=true

  # List IAM roles containing "swarm" in the name
  IAM_ROLES=$(aws iam list-roles \
    --query "Roles[?contains(RoleName, 'swarm') || contains(RoleName, 'Swarm')].[RoleName, Arn, CreateDate, Description]" \
    --output json --region "$AWS_REGION" 2>/dev/null | \
    jq '[.[] | {name: .[0], arn: .[1], created: .[2], description: .[3]}]' || echo '[]')

  # List OIDC providers
  OIDC_PROVIDERS=$(aws iam list-open-id-connect-providers \
    --query "OpenIDConnectProviderList[].Arn" \
    --output json --region "$AWS_REGION" 2>/dev/null || echo '[]')
fi

# ── 7. Findings / Alerts ────────────────────────────────────────────────
echo "Analyzing findings..." >&2
FINDINGS="[]"

# Alert: More than 2 admin users
if [[ "$ADMIN_USER_COUNT" -gt 2 ]]; then
  FINDINGS=$(echo "$FINDINGS" | jq \
    --argjson count "$ADMIN_USER_COUNT" \
    '. + [{"severity": "high", "finding": "Too many GitHub admins", "detail": ("Found " + ($count | tostring) + " admin users; expected <= 2"), "action": "Review and demote unnecessary admin accounts"}]')
fi

# Alert: Deploy keys with write access
WRITE_DEPLOY_KEYS=$(echo "$DEPLOY_KEYS" | jq '[.[] | select(.read_only == false)]')
WRITE_DEPLOY_KEY_COUNT=$(echo "$WRITE_DEPLOY_KEYS" | jq 'length')
if [[ "$WRITE_DEPLOY_KEY_COUNT" -gt 0 ]]; then
  FINDINGS=$(echo "$FINDINGS" | jq \
    --argjson count "$WRITE_DEPLOY_KEY_COUNT" \
    '. + [{"severity": "medium", "finding": "Deploy keys with write access", "detail": ("Found " + ($count | tostring) + " deploy key(s) with write access"), "action": "Verify each write-access deploy key is still needed"}]')
fi

# Alert: No environments configured (missing protection rules)
ENV_COUNT=$(echo "$ENVIRONMENTS" | jq 'length')
if [[ "$ENV_COUNT" -eq 0 ]]; then
  FINDINGS=$(echo "$FINDINGS" | jq \
    '. + [{"severity": "medium", "finding": "No GitHub environments configured", "detail": "No environments found; deployment protection rules may be missing", "action": "Configure staging and production environments with appropriate protection rules"}]')
fi

FINDINGS_COUNT=$(echo "$FINDINGS" | jq 'length')

# ── Output: JSON mode ───────────────────────────────────────────────────
build_json() {
  jq -n \
    --arg review_date "$REVIEW_DATE" \
    --arg review_quarter "$REVIEW_QUARTER" \
    --arg repo "$REPO" \
    --argjson collaborators "$COLLABORATORS" \
    --argjson admin_users "$ADMIN_USERS" \
    --argjson write_users "$WRITE_USERS" \
    --argjson total_collaborators "$TOTAL_COLLABORATORS" \
    --argjson teams "$TEAMS" \
    --argjson deploy_keys "$DEPLOY_KEYS" \
    --argjson environments "$ENVIRONMENTS" \
    --argjson admin_emails "$ADMIN_EMAILS" \
    --argjson admin_wallets "$ADMIN_WALLETS" \
    --argjson aws_available "$AWS_AVAILABLE" \
    --argjson iam_roles "$IAM_ROLES" \
    --argjson oidc_providers "$OIDC_PROVIDERS" \
    --argjson findings "$FINDINGS" \
    '{
      review_date: $review_date,
      review_quarter: $review_quarter,
      repository: $repo,
      github: {
        total_collaborators: $total_collaborators,
        admin_users: $admin_users,
        write_users: $write_users,
        teams: $teams,
        deploy_keys: $deploy_keys,
        environments: $environments
      },
      application: {
        admin_emails: $admin_emails,
        admin_wallets: $admin_wallets
      },
      aws: {
        credentials_available: $aws_available,
        iam_roles: $iam_roles,
        oidc_providers: $oidc_providers
      },
      findings: $findings,
      findings_count: ($findings | length)
    }'
}

if [[ -n "$JSON_MODE" ]]; then
  build_json
  exit 0
fi

# ── Output: Markdown mode ───────────────────────────────────────────────
report() {
  echo "# Privileged Access Review Report"
  echo ""
  echo "**Review Date:** $REVIEW_DATE"
  echo "**Review Period:** $REVIEW_QUARTER"
  echo "**Repository:** $REPO"
  echo ""

  # ── Findings ──────────────────────────────────────────────────────────
  echo "## Findings ($FINDINGS_COUNT)"
  echo ""
  if [[ "$FINDINGS_COUNT" -eq 0 ]]; then
    echo "No actionable findings."
  else
    echo "| Severity | Finding | Detail | Action Required |"
    echo "|----------|---------|--------|-----------------|"
    echo "$FINDINGS" | jq -r '.[] | "| \(.severity) | \(.finding) | \(.detail) | \(.action) |"'
  fi
  echo ""

  # ── GitHub Collaborators ──────────────────────────────────────────────
  echo "## GitHub Collaborators ($TOTAL_COLLABORATORS)"
  echo ""
  echo "### Admin Users ($ADMIN_USER_COUNT)"
  echo ""
  if [[ "$ADMIN_USER_COUNT" -eq 0 ]]; then
    echo "None."
  else
    echo "| Login | Site Admin |"
    echo "|-------|------------|"
    echo "$ADMIN_USERS" | jq -r '.[] | "| @\(.login) | \(.site_admin) |"'
  fi
  echo ""

  echo "### Write Users ($WRITE_USER_COUNT)"
  echo ""
  if [[ "$WRITE_USER_COUNT" -eq 0 ]]; then
    echo "None."
  else
    echo "| Login |"
    echo "|-------|"
    echo "$WRITE_USERS" | jq -r '.[] | "| @\(.login) |"'
  fi
  echo ""

  # ── Teams ─────────────────────────────────────────────────────────────
  TEAM_COUNT=$(echo "$TEAMS" | jq 'length')
  echo "## Teams ($TEAM_COUNT)"
  echo ""
  if [[ "$TEAM_COUNT" -eq 0 ]]; then
    echo "No teams with repository access."
  else
    echo "| Team | Permission |"
    echo "|------|------------|"
    echo "$TEAMS" | jq -r '.[] | "| \(.name) | \(.permission) |"'
  fi
  echo ""

  # ── Deploy Keys ───────────────────────────────────────────────────────
  echo "## Deploy Keys ($DEPLOY_KEY_COUNT)"
  echo ""
  if [[ "$DEPLOY_KEY_COUNT" -eq 0 ]]; then
    echo "No deploy keys configured."
  else
    echo "| Title | Read Only | Created |"
    echo "|-------|-----------|---------|"
    echo "$DEPLOY_KEYS" | jq -r '.[] | "| \(.title) | \(.read_only) | \(.created_at) |"'
  fi
  echo ""

  # ── Environments ──────────────────────────────────────────────────────
  echo "## GitHub Environments ($ENV_COUNT)"
  echo ""
  if [[ "$ENV_COUNT" -eq 0 ]]; then
    echo "No environments configured."
  else
    echo "| Name | Protection Rules |"
    echo "|------|-----------------|"
    echo "$ENVIRONMENTS" | jq -r '.[] | "| \(.name) | \([.protection_rules[].type] | join(", ")) |"'
  fi
  echo ""

  # ── Application Admin Config ──────────────────────────────────────────
  ADMIN_EMAIL_COUNT=$(echo "$ADMIN_EMAILS" | jq 'length')
  ADMIN_WALLET_COUNT=$(echo "$ADMIN_WALLETS" | jq 'length')
  echo "## Application Admin Configuration"
  echo ""
  echo "### Admin Emails ($ADMIN_EMAIL_COUNT)"
  echo ""
  if [[ "$ADMIN_EMAIL_COUNT" -eq 0 ]]; then
    echo "No admin emails found in CDK context."
  else
    echo "| Email |"
    echo "|-------|"
    echo "$ADMIN_EMAILS" | jq -r '.[] | "| \(.) |"'
  fi
  echo ""

  echo "### Admin Wallets ($ADMIN_WALLET_COUNT)"
  echo ""
  if [[ "$ADMIN_WALLET_COUNT" -eq 0 ]]; then
    echo "No admin wallets found in CDK context."
  else
    echo "| Wallet Address |"
    echo "|---------------|"
    echo "$ADMIN_WALLETS" | jq -r '.[] | "| \(.) |"'
  fi
  echo ""

  # ── AWS IAM ───────────────────────────────────────────────────────────
  echo "## AWS IAM"
  echo ""
  if [[ "$AWS_AVAILABLE" == "false" ]]; then
    echo "AWS credentials not available -- IAM review skipped."
    echo "Run this script with valid AWS credentials to include IAM role inventory."
  else
    IAM_ROLE_COUNT=$(echo "$IAM_ROLES" | jq 'length')
    echo "### IAM Roles ($IAM_ROLE_COUNT)"
    echo ""
    if [[ "$IAM_ROLE_COUNT" -eq 0 ]]; then
      echo "No matching IAM roles found."
    else
      echo "| Role Name | ARN | Created |"
      echo "|-----------|-----|---------|"
      echo "$IAM_ROLES" | jq -r '.[] | "| \(.name) | \(.arn) | \(.created) |"'
    fi
    echo ""

    OIDC_COUNT=$(echo "$OIDC_PROVIDERS" | jq 'length')
    echo "### OIDC Providers ($OIDC_COUNT)"
    echo ""
    if [[ "$OIDC_COUNT" -eq 0 ]]; then
      echo "No OIDC providers found."
    else
      echo "| ARN |"
      echo "|-----|"
      echo "$OIDC_PROVIDERS" | jq -r '.[] | "| \(.) |"'
    fi
  fi
  echo ""

  # ── Review Decision Template ──────────────────────────────────────────
  echo "## Review Decision Template"
  echo ""
  echo "Each principal above requires a decision from the reviewer:"
  echo ""
  echo "| Decision | Meaning |"
  echo "|----------|---------|"
  echo "| **Retain** | Access is appropriate and still needed |"
  echo "| **Modify** | Access level should be changed (e.g., Admin -> Write) |"
  echo "| **Revoke** | Access should be removed |"
  echo "| **Investigate** | Ownership/purpose unclear; needs follow-up |"
  echo ""
  echo "---"
  echo ""
  echo "*Report generated by \`scripts/access-review.sh\`. Retain this artifact for audit compliance.*"
}

MARKDOWN=$(report)
echo "$MARKDOWN"

# Append to GitHub Actions step summary if available
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$MARKDOWN" >> "$GITHUB_STEP_SUMMARY"
fi

# Write evidence files if output directory specified
if [[ -n "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
  echo "$MARKDOWN" > "$OUTPUT_DIR/access-review-report.md"
  build_json > "$OUTPUT_DIR/access-review-report.json"
  echo "Evidence files written to $OUTPUT_DIR" >&2
fi
