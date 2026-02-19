#!/usr/bin/env bash
# Check for unreviewed issues before commit
# Warns if there are high/critical issues not documented in the review log

set -e

ISSUES_DIR="issues/staging"
REVIEW_LOG="docs/ISSUE_REVIEW_LOG.md"

# Colors for output
RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Skip if SKIP_ISSUE_CHECK is set
if [ "${SKIP_ISSUE_CHECK:-}" = "1" ] || [ "${SKIP_ISSUE_CHECK:-}" = "true" ]; then
    echo -e "${YELLOW}pre-commit: SKIP_ISSUE_CHECK set; skipping issue review check${NC}"
    exit 0
fi

# Check if issues directory exists
if [ ! -d "$ISSUES_DIR" ]; then
    exit 0
fi

# Count issues by severity
critical_count=0
high_count=0
medium_count=0
unreviewed_critical=()
unreviewed_high=()

# Check if review log exists
if [ ! -f "$REVIEW_LOG" ]; then
    echo -e "${YELLOW}Warning: No issue review log found at $REVIEW_LOG${NC}"
    review_log_content=""
else
    review_log_content=$(cat "$REVIEW_LOG")
fi

# Extract issue prefix for matching (e.g., issue-1768933441049-avatar-1-9qhu from issue-1768933441049-avatar-1-9qhu-xxx-high.json)
# The review log uses wildcards like issue-1768933441049-avatar-1-9qhu-*-high.json
get_issue_prefix() {
    local filename="$1"
    # Remove extension and severity
    local base="${filename%.json}"
    # Extract the first 4 dash-separated parts (issue-timestamp-avatar-N-xxxx)
    echo "$base" | sed -E 's/^(issue-[0-9]+-[a-z]+-[0-9]+-[a-z0-9]+)-.*$/\1/'
}

# Check if an issue is documented (handles wildcard patterns in review log)
is_documented() {
    local filename="$1"
    local prefix
    prefix=$(get_issue_prefix "$filename")
    # Check if the prefix appears in the review log (with any suffix)
    echo "$review_log_content" | grep -q "$prefix"
}

# Scan issue and error files
for issue_file in "$ISSUES_DIR"/issue-*.json "$ISSUES_DIR"/error-*.json; do
    # Skip if no files match
    [ -e "$issue_file" ] || continue

    filename=$(basename "$issue_file")

    # Extract severity from filename (e.g., issue-xxx-high.json or error-xxx-high.json)
    if [[ "$filename" == *"-critical.json" ]]; then
        ((critical_count++))
        # Check if documented in review log
        if ! is_documented "$filename"; then
            unreviewed_critical+=("$filename")
        fi
    elif [[ "$filename" == *"-high.json" ]]; then
        ((high_count++))
        if ! is_documented "$filename"; then
            unreviewed_high+=("$filename")
        fi
    elif [[ "$filename" == *"-medium.json" ]]; then
        ((medium_count++))
    fi
done

# Calculate totals
total_issues=$((critical_count + high_count + medium_count))
unreviewed_count=$((${#unreviewed_critical[@]} + ${#unreviewed_high[@]}))

# Report findings
if [ $total_issues -eq 0 ]; then
    echo -e "${GREEN}pre-commit: No issues found${NC}"
    exit 0
fi

echo "pre-commit: Issue scan complete"
echo "  Total issues: $total_issues (critical: $critical_count, high: $high_count, medium: $medium_count)"

if [ $unreviewed_count -eq 0 ]; then
    echo -e "${GREEN}  All high/critical issues are documented in review log${NC}"
    exit 0
fi

# Show unreviewed issues
echo ""
if [ ${#unreviewed_critical[@]} -gt 0 ]; then
    echo -e "${RED}  Unreviewed CRITICAL issues (${#unreviewed_critical[@]}):${NC}"
    for issue in "${unreviewed_critical[@]}"; do
        echo "    - $issue"
    done
fi

if [ ${#unreviewed_high[@]} -gt 0 ]; then
    echo -e "${YELLOW}  Unreviewed HIGH issues (${#unreviewed_high[@]}):${NC}"
    for issue in "${unreviewed_high[@]}"; do
        echo "    - $issue"
    done
fi

echo ""
echo -e "${YELLOW}  Consider reviewing these issues and updating $REVIEW_LOG${NC}"
echo "  To skip this check: SKIP_ISSUE_CHECK=1 git commit ..."
echo ""

# Block commit if there are unreviewed critical issues
if [ ${#unreviewed_critical[@]} -gt 0 ]; then
    echo -e "${RED}Commit blocked: Unreviewed critical issues found${NC}"
    echo "Please review critical issues before committing or use SKIP_ISSUE_CHECK=1 to bypass"
    exit 1
fi

# Warn but allow for high issues
exit 0
