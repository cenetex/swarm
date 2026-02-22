#!/usr/bin/env node
/**
 * project-sync.mjs
 *
 * Called by the project-sync workflow on issue/PR/branch events.
 * 1. Adds the item to the GitHub Project (idempotent).
 * 2. Maps issue labels to project single-select fields (Priority, Status).
 * 3. Sets Iteration from roadmap milestones:
 *    - Roadmap: Now  -> current iteration
 *    - Roadmap: Next -> next iteration
 *    - Roadmap: Later -> no automatic assignment
 * 4. Syncs issue status based on branch/PR lifecycle.
 *    - status:blocked label maps to Status="Blocked" when available.
 *
 * Required env vars (set by the workflow):
 *   GH_TOKEN, PROJECT_OWNER, PROJECT_NUMBER,
 *   ISSUE_NODE_ID, ISSUE_LABELS, ISSUE_MILESTONE, ISSUE_STATE,
 *   EVENT_NAME, EVENT_ACTION,
 *   PR_MERGED, PR_DRAFT, PR_NUMBER, PR_BODY,
 *   BRANCH_REF, BRANCH_REF_TYPE
 */

import { execFileSync } from "node:child_process";

const PROJECT_OWNER = process.env.PROJECT_OWNER || "cenetex";
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER || "1");

const MAX_GH_RETRIES = Number(process.env.PROJECT_SYNC_GH_MAX_RETRIES || "5");
const BASE_BACKOFF_MS = Number(process.env.PROJECT_SYNC_GH_BACKOFF_MS || "1200");

const PRIORITY_MAP = {
  "priority:high": "P0",
  "priority:medium": "P1",
  "priority:low": "P2",
};

const BRANCH_ISSUE_RE = /issue-(\d+)/;
const CLOSING_KEYWORD_RE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

const SINGLE_SELECT_FIELD_CACHE = new Map();
let ITERATION_FIELD_CACHE = null;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableGhFailure(error) {
  const text = [error?.message, error?.stdout, error?.stderr]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return (
    text.includes("rate limit") ||
    text.includes("secondary rate") ||
    text.includes("stream disconnected") ||
    text.includes("timed out") ||
    text.includes("connection reset")
  );
}

function gh(args) {
  for (let attempt = 0; attempt <= MAX_GH_RETRIES; attempt += 1) {
    try {
      const result = execFileSync("gh", args, {
        encoding: "utf-8",
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
      });
      return result.trim();
    } catch (error) {
      if (!isRetryableGhFailure(error) || attempt === MAX_GH_RETRIES) {
        throw error;
      }
      const waitMs = BASE_BACKOFF_MS * (attempt + 1);
      console.log(`gh retry ${attempt + 1}/${MAX_GH_RETRIES} after ${waitMs}ms`);
      sleepMs(waitMs);
    }
  }

  throw new Error("unreachable");
}

function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    const flag = typeof v === "number" || typeof v === "boolean" ? "-F" : "-f";
    args.push(flag, `${k}=${v}`);
  }
  return JSON.parse(gh(args));
}

function getProjectId() {
  const res = graphql(
    `
    query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) { id }
      }
    }
  `,
    { owner: PROJECT_OWNER, number: PROJECT_NUMBER },
  );

  return res.data.organization.projectV2.id;
}

function getSingleSelectFieldMeta(projectId, fieldName) {
  const cacheKey = `${projectId}:${fieldName}`;
  if (SINGLE_SELECT_FIELD_CACHE.has(cacheKey)) {
    return SINGLE_SELECT_FIELD_CACHE.get(cacheKey);
  }

  const res = graphql(
    `
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
  `,
    { projectId },
  );

  const field = res.data.node.field || null;
  SINGLE_SELECT_FIELD_CACHE.set(cacheKey, field);
  return field;
}

function getFieldOptionId(projectId, fieldName, optionName) {
  const field = getSingleSelectFieldMeta(projectId, fieldName);
  if (!field || !field.options) return null;
  const option = field.options.find((opt) => opt.name === optionName);
  return option ? { fieldId: field.id, optionId: option.id } : null;
}

function getIterationFieldMeta(projectId) {
  if (ITERATION_FIELD_CACHE) return ITERATION_FIELD_CACHE;

  const res = graphql(
    `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          field(name: "Iteration") {
            ... on ProjectV2IterationField {
              id
              configuration {
                iterations {
                  id
                  title
                  startDate
                  duration
                }
                completedIterations {
                  id
                  title
                  startDate
                  duration
                }
              }
            }
          }
        }
      }
    }
  `,
    { projectId },
  );

  ITERATION_FIELD_CACHE = res.data.node.field || null;
  return ITERATION_FIELD_CACHE;
}

function resolveCurrentAndNextIterations(iterations) {
  const sorted = [...iterations].sort(
    (a, b) => Date.parse(a.startDate) - Date.parse(b.startDate),
  );

  if (sorted.length === 0) {
    return { currentIteration: null, nextIteration: null };
  }

  const now = new Date();
  let currentIteration = sorted.find((iteration) => {
    const start = new Date(`${iteration.startDate}T00:00:00.000Z`);
    const durationDays = iteration.duration || 14;
    const end = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
    return now >= start && now < end;
  });

  if (!currentIteration) {
    currentIteration =
      sorted.find((iteration) => now < new Date(`${iteration.startDate}T00:00:00.000Z`)) || sorted[0];
  }

  const nextIteration =
    sorted.find(
      (iteration) => Date.parse(iteration.startDate) > Date.parse(currentIteration.startDate),
    ) || null;

  return { currentIteration, nextIteration };
}

function resolveIterationFromMilestone(projectId, milestoneTitle) {
  const normalized = String(milestoneTitle || "").trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === "roadmap: later") {
    console.log("  Iteration: milestone is Roadmap: Later — skipping automatic assignment");
    return null;
  }

  if (normalized !== "roadmap: now" && normalized !== "roadmap: next") {
    return null;
  }

  const iterationField = getIterationFieldMeta(projectId);
  if (!iterationField) {
    console.log("  Iteration field not found — skipping automatic assignment");
    return null;
  }

  const liveIterations = iterationField.configuration?.iterations || [];
  const { currentIteration, nextIteration } = resolveCurrentAndNextIterations(liveIterations);

  if (normalized === "roadmap: now") {
    if (!currentIteration) {
      console.log("  Could not resolve current iteration for Roadmap: Now");
      return null;
    }
    return { fieldId: iterationField.id, iteration: currentIteration };
  }

  if (!nextIteration) {
    console.log("  Could not resolve next iteration for Roadmap: Next");
    return null;
  }

  return { fieldId: iterationField.id, iteration: nextIteration };
}

function addItemToProject(projectId, contentId) {
  const res = graphql(
    `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `,
    { projectId, contentId },
  );

  return res.data.addProjectV2ItemById.item.id;
}

function setSingleSelectFieldValue(projectId, itemId, fieldId, optionId) {
  graphql(
    `
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
  `,
    { projectId, itemId, fieldId, optionId },
  );
}

function setIterationFieldValue(projectId, itemId, fieldId, iterationId) {
  graphql(
    `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { iterationId: $iterationId }
      }) {
        projectV2Item { id }
      }
    }
  `,
    { projectId, itemId, fieldId, iterationId },
  );
}

function clearFieldValue(projectId, itemId, fieldId) {
  graphql(
    `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId
      }) {
        projectV2Item { id }
      }
    }
  `,
    { projectId, itemId, fieldId },
  );
}

function setStatusWithFallback(projectId, itemId, requestedStatus, contextLabel = "") {
  let resolved = getFieldOptionId(projectId, "Status", requestedStatus);
  let resolvedStatus = requestedStatus;

  if (!resolved && requestedStatus === "In review") {
    resolved = getFieldOptionId(projectId, "Status", "In progress");
    resolvedStatus = "In progress";
    if (resolved) {
      console.log(`${contextLabel}Status fallback: In review -> In progress`);
    }
  }

  if (!resolved) {
    console.log(`${contextLabel}Status option '${requestedStatus}' not found — skipping`);
    return false;
  }

  setSingleSelectFieldValue(projectId, itemId, resolved.fieldId, resolved.optionId);
  console.log(`${contextLabel}Status -> ${resolvedStatus}`);
  return true;
}

function setIterationFromMilestone(projectId, itemId, milestoneTitle, contextLabel = "") {
  const normalized = String(milestoneTitle || "").trim().toLowerCase();
  if (!normalized || normalized === "roadmap: later") {
    const iterationField = getIterationFieldMeta(projectId);
    if (!iterationField) {
      return false;
    }

    clearFieldValue(projectId, itemId, iterationField.id);
    const reason = normalized === "roadmap: later" ? "Roadmap: Later" : "no milestone";
    console.log(`${contextLabel}Iteration cleared (${reason})`);
    return true;
  }

  const resolved = resolveIterationFromMilestone(projectId, milestoneTitle);
  if (!resolved) {
    return false;
  }

  setIterationFieldValue(projectId, itemId, resolved.fieldId, resolved.iteration.id);
  console.log(`${contextLabel}Iteration -> ${resolved.iteration.title}`);
  return true;
}

function issueNumberFromBranch(branchName) {
  const match = String(branchName || "").match(BRANCH_ISSUE_RE);
  return match ? Number(match[1]) : null;
}

function resolveLinkedIssues(prNumber, prBody) {
  const issues = new Set();

  if (prNumber) {
    try {
      const prJson = gh(["pr", "view", String(prNumber), "--json", "closingIssuesReferences"]);
      const parsed = JSON.parse(prJson);
      for (const ref of parsed.closingIssuesReferences || []) {
        issues.add(ref.number);
      }
    } catch {
      // Fallback to body regex below.
    }
  }

  if (prBody) {
    let match;
    while ((match = CLOSING_KEYWORD_RE.exec(prBody)) !== null) {
      issues.add(Number(match[1]));
    }
  }

  return issues;
}

function getIssueNodeData(issueNumber) {
  try {
    const json = gh([
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "id,labels,state,milestone",
    ]);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function checkOpenPRsForIssue(issueNumber) {
  let hasOpenPR = false;
  let hasReadyPR = false;

  try {
    const prsJson = gh([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,headRefName,body,isDraft",
    ]);
    const prs = JSON.parse(prsJson);

    for (const pr of prs) {
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
    // If PR listing fails, conservatively keep default false/false.
  }

  return { hasOpenPR, hasReadyPR };
}

function applyIssueStatus(projectId, issueNumber, desiredStatus) {
  const issueData = getIssueNodeData(issueNumber);
  if (!issueData) {
    console.log(`  #${issueNumber}: could not resolve issue — skipping`);
    return false;
  }

  const labels = (issueData.labels || []).map((label) => label.name);
  const issueState = (issueData.state || "open").toLowerCase();
  const contextLabel = `  #${issueNumber}: `;

  if (issueState === "closed" && desiredStatus !== "Done") {
    console.log(`${contextLabel}issue is closed — not setting ${desiredStatus}`);
    return false;
  }

  const itemId = addItemToProject(projectId, issueData.id);
  if (issueState !== "closed") {
    setIterationFromMilestone(projectId, itemId, issueData.milestone?.title, contextLabel);
  }

  if (labels.includes("status:blocked") && desiredStatus !== "Done") {
    const appliedBlocked = setStatusWithFallback(projectId, itemId, "Blocked", contextLabel);
    if (!appliedBlocked) {
      console.log(`${contextLabel}has status:blocked label — leaving status unchanged`);
    }
    return appliedBlocked;
  }

  return setStatusWithFallback(projectId, itemId, desiredStatus, contextLabel);
}

function handleIssueEvent(projectId) {
  const nodeId = process.env.ISSUE_NODE_ID;
  const labels = JSON.parse(process.env.ISSUE_LABELS || "[]");
  const issueState = (process.env.ISSUE_STATE || "open").toLowerCase();
  const eventAction = process.env.EVENT_ACTION || "";
  const prMerged = process.env.PR_MERGED === "true";
  const issueNumber = process.env.ISSUE_NUMBER || "?";
  const issueMilestone = process.env.ISSUE_MILESTONE || "";

  if (!nodeId) {
    console.log("No ISSUE_NODE_ID — skipping.");
    return;
  }

  console.log(`Processing issue #${issueNumber} (issues/${eventAction})`);

  const itemId = addItemToProject(projectId, nodeId);
  console.log(`  Added/found project item: ${itemId}`);

  for (const [label, optionName] of Object.entries(PRIORITY_MAP)) {
    if (!labels.includes(label)) continue;

    const info = getFieldOptionId(projectId, "Priority", optionName);
    if (info) {
      setSingleSelectFieldValue(projectId, itemId, info.fieldId, info.optionId);
      console.log(`  Priority -> ${optionName}`);
    }
    break;
  }

  if (issueState !== "closed") {
    setIterationFromMilestone(projectId, itemId, issueMilestone, "  ");
  }

  let desiredStatus = null;

  if (issueState === "closed" || prMerged) {
    desiredStatus = "Done";
  } else if (labels.includes("status:blocked")) {
    desiredStatus = "Blocked";
  } else if (labels.includes("status:in-progress")) {
    desiredStatus = "In progress";
  } else if (eventAction === "reopened") {
    desiredStatus = "Todo";
  }

  if (desiredStatus) {
    setStatusWithFallback(projectId, itemId, desiredStatus, "  ");
  }
}

function handlePullRequestEvent(projectId) {
  const eventAction = process.env.EVENT_ACTION || "";
  const prMerged = process.env.PR_MERGED === "true";
  const prDraft = process.env.PR_DRAFT === "true";
  const prNumber = process.env.PR_NUMBER || "";
  const prBody = process.env.PR_BODY || "";
  const nodeId = process.env.ISSUE_NODE_ID;
  const issueMilestone = process.env.ISSUE_MILESTONE || "";

  console.log(
    `Processing PR #${prNumber} (pull_request/${eventAction}, merged=${prMerged}, draft=${prDraft})`,
  );

  if (nodeId) {
    const labels = JSON.parse(process.env.ISSUE_LABELS || "[]");
    const itemId = addItemToProject(projectId, nodeId);
    console.log(`  Added/found PR project item: ${itemId}`);

    for (const [label, optionName] of Object.entries(PRIORITY_MAP)) {
      if (!labels.includes(label)) continue;

      const info = getFieldOptionId(projectId, "Priority", optionName);
      if (info) {
        setSingleSelectFieldValue(projectId, itemId, info.fieldId, info.optionId);
        console.log(`  PR Priority -> ${optionName}`);
      }
      break;
    }

    setIterationFromMilestone(projectId, itemId, issueMilestone, "  ");
  }

  const linkedIssues = resolveLinkedIssues(prNumber, prBody);

  try {
    const prJson = gh(["pr", "view", String(prNumber), "--json", "headRefName"]);
    const parsed = JSON.parse(prJson);
    const branchIssue = issueNumberFromBranch(parsed.headRefName);
    if (branchIssue) {
      linkedIssues.add(branchIssue);
    }
  } catch {
    // best effort
  }

  if (linkedIssues.size === 0) {
    console.log("  No linked issues found for PR.");
    return;
  }

  console.log(`  Linked issues: ${[...linkedIssues].join(", ")}`);

  let desiredStatus = null;

  if (eventAction === "closed" && prMerged) {
    desiredStatus = "Done";
  } else if (eventAction === "closed" && !prMerged) {
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
    return;
  } else if (eventAction === "converted_to_draft") {
    desiredStatus = "In progress";
  } else if (
    eventAction === "opened" ||
    eventAction === "reopened" ||
    eventAction === "ready_for_review"
  ) {
    desiredStatus = prDraft ? "In progress" : "In review";
  }

  if (!desiredStatus) return;

  for (const num of linkedIssues) {
    applyIssueStatus(projectId, num, desiredStatus);
  }
}

function handleBranchEvent(projectId) {
  const eventName = process.env.EVENT_NAME || "";
  const refType = process.env.BRANCH_REF_TYPE || "";
  const ref = process.env.BRANCH_REF || "";

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
    const { hasReadyPR } = checkOpenPRsForIssue(issueNum);
    if (hasReadyPR) {
      applyIssueStatus(projectId, issueNum, "In review");
    } else {
      applyIssueStatus(projectId, issueNum, "In progress");
    }
    return;
  }

  if (eventName === "delete") {
    const { hasOpenPR, hasReadyPR } = checkOpenPRsForIssue(issueNum);
    if (hasReadyPR) {
      applyIssueStatus(projectId, issueNum, "In review");
    } else if (hasOpenPR) {
      applyIssueStatus(projectId, issueNum, "In progress");
    } else {
      applyIssueStatus(projectId, issueNum, "Todo");
    }
  }
}

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
