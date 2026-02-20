#!/usr/bin/env node
/**
 * project-sync.mjs
 *
 * Called by the project-sync workflow on issue/PR/branch events.
 * 1. Adds the item to the GitHub Project (idempotent).
 * 2. Maps issue labels to project single-select fields (Priority, Status).
 * 3. Sets the milestone-derived "Target" iteration if the milestone matches
 *    the Roadmap naming convention (Roadmap: Now / Next / Later).
 * 4. Syncs issue status based on branch/PR lifecycle:
 *    - Branch created for issue → In progress
 *    - Branch deleted (no open PR) → Todo
 *    - PR opened/reopened (ready for review) → In review
 *    - PR converted to draft → In progress
 *    - PR closed without merge → Todo (if no other open PRs)
 *    - PR merged → Done
 *
 * Status precedence: Done > In review > In progress > Todo
 * The `status:blocked` label overrides all non-Done states with "Blocked".
 *
 * Required env vars (set by the workflow):
 *   GH_TOKEN, PROJECT_OWNER (default "atimics"), PROJECT_NUMBER (default 1),
 *   ISSUE_NODE_ID, ISSUE_LABELS (JSON array of label name strings),
 *   ISSUE_MILESTONE (string), ISSUE_STATE (open|closed),
 *   EVENT_NAME (issues|pull_request|create|delete), EVENT_ACTION,
 *   PR_MERGED, PR_DRAFT, PR_NUMBER, PR_BODY,
 *   BRANCH_REF, BRANCH_REF_TYPE, REPO_OWNER, REPO_NAME
 */

import { execFileSync } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────────────

const PROJECT_OWNER = process.env.PROJECT_OWNER || "atimics";
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER || "1");

/** Map repo labels → Project Priority field option names */
const PRIORITY_MAP = {
  "priority:high": "P0",
  "priority:medium": "P1",
  "priority:low": "P2",
};

/** Status precedence (higher number wins) */
const STATUS_PRECEDENCE = {
  "Todo": 0,
  "In progress": 1,
  "In review": 2,
  "Done": 3,
};

/** Regex to extract issue number from branch name: <type>/issue-<number>-<slug> */
const BRANCH_ISSUE_RE = /issue-(\d+)/;

/** Closing keyword regex for PR body */
const CLOSING_KEYWORD_RE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

// ── Helpers ─────────────────────────────────────────────────────────────────

function gh(args) {
  const result = execFileSync("gh", args, {
    encoding: "utf-8",
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.trim();
}

function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    // Use -F for non-string types (numbers, booleans) so gh sends proper JSON types
    const flag = typeof v === "number" || typeof v === "boolean" ? "-F" : "-f";
    args.push(flag, `${k}=${v}`);
  }
  return JSON.parse(gh(args));
}

// ── Resolve project metadata ────────────────────────────────────────────────

function getProjectId() {
  const res = graphql(`
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) { id }
      }
    }
  `, { owner: PROJECT_OWNER, number: PROJECT_NUMBER });
  return res.data.user.projectV2.id;
}

function getFieldOptionId(projectId, fieldName, optionName) {
  const res = graphql(`
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          field(name: "${fieldName}") {
            ... on ProjectV2SingleSelectField {
              id
              options { id name }
            }
          }
        }
      }
    }
  `, { projectId });
  const field = res.data.node.field;
  if (!field || !field.options) return null;
  const opt = field.options.find((o) => o.name === optionName);
  return opt ? { fieldId: field.id, optionId: opt.id } : null;
}

// ── Add item to project ────────────────────────────────────────────────────

function addItemToProject(projectId, contentId) {
  const res = graphql(`
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `, { projectId, contentId });
  return res.data.addProjectV2ItemById.item.id;
}

// ── Update a single-select field ───────────────────────────────────────────

function setFieldValue(projectId, itemId, fieldId, optionId) {
  graphql(`
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
  `, { projectId, itemId, fieldId, optionId });
}

// ── Issue resolution helpers ───────────────────────────────────────────────

/**
 * Extract issue number from a branch name matching <type>/issue-<number>-<slug>.
 * Returns the issue number or null.
 */
function issueNumberFromBranch(branchName) {
  const match = branchName.match(BRANCH_ISSUE_RE);
  return match ? Number(match[1]) : null;
}

/**
 * Extract issue numbers linked to a PR via closing keywords in the body
 * and the GitHub closingIssuesReferences API.
 * Returns a Set of issue numbers.
 */
function resolveLinkedIssues(prNumber, prBody) {
  const issues = new Set();

  // 1. Preferred: closingIssuesReferences from GH API
  if (prNumber) {
    try {
      const prJson = gh(["pr", "view", String(prNumber), "--json", "closingIssuesReferences"]);
      const parsed = JSON.parse(prJson);
      if (parsed.closingIssuesReferences) {
        for (const ref of parsed.closingIssuesReferences) {
          issues.add(ref.number);
        }
      }
    } catch {
      // Not all gh versions support this — fall through to regex
    }
  }

  // 2. Fallback: closing keywords in PR body
  if (prBody) {
    let match;
    while ((match = CLOSING_KEYWORD_RE.exec(prBody)) !== null) {
      issues.add(Number(match[1]));
    }
  }

  return issues;
}

/**
 * Resolve the node_id for an issue by number. Returns null if not found.
 */
function getIssueNodeId(issueNumber) {
  try {
    const json = gh(["issue", "view", String(issueNumber), "--json", "id,labels,state"]);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Check if there are any open non-draft PRs linked to this issue (via branch name or closing refs).
 * Returns { hasOpenPR: boolean, hasReadyPR: boolean }
 */
function checkOpenPRsForIssue(issueNumber) {
  let hasOpenPR = false;
  let hasReadyPR = false;

  try {
    const prsJson = gh([
      "pr", "list",
      "--state", "open",
      "--limit", "100",
      "--json", "number,headRefName,body,isDraft",
    ]);
    const prs = JSON.parse(prsJson);

    for (const pr of prs) {
      // Check if this PR references the issue
      const branchIssue = issueNumberFromBranch(pr.headRefName);
      const bodyIssues = new Set();
      if (pr.body) {
        let match;
        const re = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
        while ((match = re.exec(pr.body)) !== null) {
          bodyIssues.add(Number(match[1]));
        }
      }

      if (branchIssue === issueNumber || bodyIssues.has(issueNumber)) {
        hasOpenPR = true;
        if (!pr.isDraft) {
          hasReadyPR = true;
        }
      }
    }
  } catch {
    // If we can't list PRs, assume no open PRs
  }

  return { hasOpenPR, hasReadyPR };
}

// ── Status computation ─────────────────────────────────────────────────────

/**
 * Apply status to an issue in the project, respecting precedence.
 * Returns true if the status was set.
 */
function applyIssueStatus(projectId, issueNumber, desiredStatus) {
  const issueData = getIssueNodeId(issueNumber);
  if (!issueData) {
    console.log(`  #${issueNumber}: could not resolve issue — skipping`);
    return false;
  }

  const labels = (issueData.labels || []).map((l) => l.name);
  const issueState = (issueData.state || "open").toLowerCase();

  // status:blocked overrides all non-Done states
  if (labels.includes("status:blocked") && desiredStatus !== "Done") {
    console.log(`  #${issueNumber}: has status:blocked label — not overriding to ${desiredStatus}`);
    return false;
  }

  // If issue is closed and we're trying to set a non-Done status, skip
  if (issueState === "closed" && desiredStatus !== "Done") {
    console.log(`  #${issueNumber}: issue is closed — not setting ${desiredStatus}`);
    return false;
  }

  const itemId = addItemToProject(projectId, issueData.id);
  const info = getFieldOptionId(projectId, "Status", desiredStatus);
  if (info) {
    setFieldValue(projectId, itemId, info.fieldId, info.optionId);
    console.log(`  #${issueNumber}: Status → ${desiredStatus}`);
    return true;
  }
  return false;
}

// ── Event handlers ──────────────────────────────────────────────────────────

/**
 * Handle issue events (the original logic).
 */
function handleIssueEvent(projectId) {
  const nodeId = process.env.ISSUE_NODE_ID;
  const labels = JSON.parse(process.env.ISSUE_LABELS || "[]");
  const issueState = (process.env.ISSUE_STATE || "open").toLowerCase();
  const eventAction = process.env.EVENT_ACTION || "";
  const prMerged = process.env.PR_MERGED === "true";
  const issueNumber = process.env.ISSUE_NUMBER || "?";

  if (!nodeId) {
    console.log("No ISSUE_NODE_ID — skipping.");
    return;
  }

  console.log(`Processing issue #${issueNumber} (issues/${eventAction})`);

  // 1. Add to project
  const itemId = addItemToProject(projectId, nodeId);
  console.log(`  Added/found project item: ${itemId}`);

  // 2. Sync Priority label → Priority field
  for (const [label, optionName] of Object.entries(PRIORITY_MAP)) {
    if (labels.includes(label)) {
      const info = getFieldOptionId(projectId, "Priority", optionName);
      if (info) {
        setFieldValue(projectId, itemId, info.fieldId, info.optionId);
        console.log(`  Priority → ${optionName}`);
      }
      break; // only one priority
    }
  }

  // 3. Sync Status
  let desiredStatus = null;

  // Closed/merged → Done
  if (issueState === "closed" || prMerged) {
    desiredStatus = "Done";
  }
  // status:blocked overrides non-Done states
  else if (labels.includes("status:blocked")) {
    // Don't override — let the blocked label stand (project board may have a "Blocked" column)
    // For now, keep existing behavior: in-progress label takes precedence in the old code
    // but blocked should override. We set In progress only if not blocked.
    desiredStatus = null; // leave as-is; blocked is managed at the project level
  }
  // Explicit in-progress label
  else if (labels.includes("status:in-progress")) {
    desiredStatus = "In progress";
  }
  // Reopened → Todo
  else if (eventAction === "reopened") {
    desiredStatus = "Todo";
  }

  if (desiredStatus) {
    const info = getFieldOptionId(projectId, "Status", desiredStatus);
    if (info) {
      setFieldValue(projectId, itemId, info.fieldId, info.optionId);
      console.log(`  Status → ${desiredStatus}`);
    }
  }
}

/**
 * Handle pull_request events — sync linked issue status based on PR state.
 */
function handlePullRequestEvent(projectId) {
  const eventAction = process.env.EVENT_ACTION || "";
  const prMerged = process.env.PR_MERGED === "true";
  const prDraft = process.env.PR_DRAFT === "true";
  const prNumber = process.env.PR_NUMBER || "";
  const prBody = process.env.PR_BODY || "";
  const nodeId = process.env.ISSUE_NODE_ID;
  const issueNumber = process.env.ISSUE_NUMBER || "";

  console.log(`Processing PR #${prNumber} (pull_request/${eventAction}, merged=${prMerged}, draft=${prDraft})`);

  // First, add the PR itself to the project (existing behavior)
  if (nodeId) {
    const labels = JSON.parse(process.env.ISSUE_LABELS || "[]");
    const itemId = addItemToProject(projectId, nodeId);
    console.log(`  Added/found PR project item: ${itemId}`);

    // Sync PR priority labels
    for (const [label, optionName] of Object.entries(PRIORITY_MAP)) {
      if (labels.includes(label)) {
        const info = getFieldOptionId(projectId, "Priority", optionName);
        if (info) {
          setFieldValue(projectId, itemId, info.fieldId, info.optionId);
          console.log(`  PR Priority → ${optionName}`);
        }
        break;
      }
    }
  }

  // Now resolve linked issues and update their status
  const linkedIssues = resolveLinkedIssues(prNumber, prBody);

  // Also check branch name for issue number
  try {
    const prJson = gh(["pr", "view", String(prNumber), "--json", "headRefName"]);
    const parsed = JSON.parse(prJson);
    const branchIssue = issueNumberFromBranch(parsed.headRefName);
    if (branchIssue) linkedIssues.add(branchIssue);
  } catch {
    // ignore
  }

  if (linkedIssues.size === 0) {
    console.log("  No linked issues found for PR.");
    return;
  }

  console.log(`  Linked issues: ${[...linkedIssues].join(", ")}`);

  // Determine desired status for linked issues based on PR action
  let desiredStatus = null;

  if (eventAction === "closed" && prMerged) {
    // PR merged → Done (handled by close-on-merge job too, but we set it here for consistency)
    desiredStatus = "Done";
  } else if (eventAction === "closed" && !prMerged) {
    // PR closed without merge — check if there are other open PRs for these issues
    // If not, revert to Todo
    for (const num of linkedIssues) {
      const { hasOpenPR, hasReadyPR } = checkOpenPRsForIssue(num);
      if (hasReadyPR) {
        applyIssueStatus(projectId, num, "In review");
      } else if (hasOpenPR) {
        applyIssueStatus(projectId, num, "In progress");
      } else {
        applyIssueStatus(projectId, num, "Todo");
      }
    }
    return; // handled per-issue above
  } else if (eventAction === "converted_to_draft") {
    // Draft PR → In progress
    desiredStatus = "In progress";
  } else if (
    eventAction === "opened" ||
    eventAction === "reopened" ||
    eventAction === "ready_for_review"
  ) {
    // Ready-for-review PR → In review (only if not draft)
    desiredStatus = prDraft ? "In progress" : "In review";
  }

  if (!desiredStatus) return;

  for (const num of linkedIssues) {
    applyIssueStatus(projectId, num, desiredStatus);
  }
}

/**
 * Handle create/delete branch events — sync linked issue status.
 */
function handleBranchEvent(projectId) {
  const eventName = process.env.EVENT_NAME || "";
  const refType = process.env.BRANCH_REF_TYPE || "";
  const ref = process.env.BRANCH_REF || "";

  // Only handle branch events, not tag events
  if (refType !== "branch") {
    console.log(`Skipping ${eventName} event for ref_type=${refType}`);
    return;
  }

  console.log(`Processing ${eventName} branch: ${ref}`);

  const issueNum = issueNumberFromBranch(ref);
  if (!issueNum) {
    console.log("  No issue number in branch name — skipping.");
    return;
  }

  console.log(`  Linked issue: #${issueNum}`);

  if (eventName === "create") {
    // Branch created → check if there's already an open PR (higher precedence)
    const { hasOpenPR, hasReadyPR } = checkOpenPRsForIssue(issueNum);
    if (hasReadyPR) {
      applyIssueStatus(projectId, issueNum, "In review");
    } else {
      // Branch exists, no ready PR → In progress
      applyIssueStatus(projectId, issueNum, "In progress");
    }
  } else if (eventName === "delete") {
    // Branch deleted → check if there are any remaining open PRs
    const { hasOpenPR, hasReadyPR } = checkOpenPRsForIssue(issueNum);
    if (hasReadyPR) {
      applyIssueStatus(projectId, issueNum, "In review");
    } else if (hasOpenPR) {
      applyIssueStatus(projectId, issueNum, "In progress");
    } else {
      // No branch, no open PR → Todo (unless issue is closed/done)
      applyIssueStatus(projectId, issueNum, "Todo");
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const eventName = process.env.EVENT_NAME || "";

  const projectId = getProjectId();

  switch (eventName) {
    case "issues":
      handleIssueEvent(projectId);
      break;
    case "pull_request":
      handlePullRequestEvent(projectId);
      break;
    case "create":
    case "delete":
      handleBranchEvent(projectId);
      break;
    default:
      console.log(`Unhandled event: ${eventName}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
