#!/usr/bin/env node
/**
 * project-sync-reconcile.mjs
 *
 * Nightly reconciliation job. Walks every open issue in the repo and ensures
 * it is present in the GitHub Project with the correct field values.
 * Reports drift fixes in the workflow summary via GITHUB_STEP_SUMMARY.
 *
 * Required env vars:
 *   GH_TOKEN, DRY_RUN (default "false")
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const PROJECT_OWNER = process.env.PROJECT_OWNER || "atimics";
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER || "1");
const DRY_RUN = process.env.DRY_RUN === "true";
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || "";

const PRIORITY_MAP = {
  "priority:high": "P0",
  "priority:medium": "P1",
  "priority:low": "P2",
};

const STATUS_MAP = {
  "status:in-progress": "In progress",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    const flag = typeof v === "number" || typeof v === "boolean" ? "-F" : "-f";
    args.push(flag, `${k}=${v}`);
  }
  return JSON.parse(gh(args));
}

function writeSummary(text) {
  console.log(text);
  if (SUMMARY_FILE) {
    try {
      appendFileSync(SUMMARY_FILE, text + "\n");
    } catch { /* ignore outside Actions */ }
  }
}

// ── Project helpers (reused from project-sync.mjs) ─────────────────────────

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

function getFieldMeta(projectId, fieldName) {
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
  return res.data.node.field;
}

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

/**
 * Get the current project-field values for an item so we can detect drift.
 */
function getItemFields(projectId, itemId) {
  const res = graphql(`
    query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field { ... on ProjectV2SingleSelectField { name } }
                name
                optionId
              }
            }
          }
        }
      }
    }
  `, { itemId });
  const fields = {};
  for (const node of res.data.node.fieldValues?.nodes || []) {
    if (node.field?.name && node.name) {
      fields[node.field.name] = { name: node.name, optionId: node.optionId };
    }
  }
  return fields;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  writeSummary("# Project Sync Reconciliation Report");
  writeSummary("");
  writeSummary(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  writeSummary("");

  // Fetch all open issues
  const issuesJson = gh([
    "issue", "list",
    "--state", "open",
    "--limit", "500",
    "--json", "number,title,labels,milestone,id,state",
  ]);
  const issues = JSON.parse(issuesJson);
  console.log(`Found ${issues.length} open issues`);

  // Also fetch closed issues (recently closed within last 7 days for Done sync)
  const closedJson = gh([
    "issue", "list",
    "--state", "closed",
    "--limit", "100",
    "--json", "number,title,labels,milestone,id,state",
  ]);
  const closedIssues = JSON.parse(closedJson);
  const allIssues = [...issues, ...closedIssues];
  console.log(`Including ${closedIssues.length} recently closed issues`);

  const projectId = getProjectId();
  const priorityField = getFieldMeta(projectId, "Priority");
  const statusField = getFieldMeta(projectId, "Status");

  let driftCount = 0;
  let addedCount = 0;
  const driftDetails = [];

  for (const issue of allIssues) {
    const labels = issue.labels.map((l) => l.name);
    const issueState = issue.state?.toLowerCase() || "open";

    // 1. Add to project (idempotent)
    let itemId;
    try {
      itemId = addItemToProject(projectId, issue.id);
    } catch (err) {
      console.log(`  #${issue.number}: failed to add — ${err.message}`);
      continue;
    }

    // 2. Read current fields
    const currentFields = getItemFields(projectId, itemId);

    // 3. Compute desired Priority
    let desiredPriority = null;
    for (const [label, optionName] of Object.entries(PRIORITY_MAP)) {
      if (labels.includes(label)) {
        desiredPriority = optionName;
        break;
      }
    }

    // 4. Compute desired Status
    let desiredStatus = null;
    if (issueState === "closed") {
      desiredStatus = "Done";
    } else if (labels.includes("status:in-progress")) {
      desiredStatus = "In progress";
    } else {
      desiredStatus = "Todo";
    }

    // 5. Check and fix Priority drift
    if (desiredPriority) {
      const current = currentFields.Priority?.name;
      if (current !== desiredPriority) {
        const opt = priorityField.options.find((o) => o.name === desiredPriority);
        if (opt) {
          driftCount++;
          driftDetails.push(
            `#${issue.number}: Priority ${current || "(none)"} → ${desiredPriority}`
          );
          if (!DRY_RUN) {
            setFieldValue(projectId, itemId, priorityField.id, opt.id);
          }
        }
      }
    }

    // 6. Check and fix Status drift
    if (desiredStatus) {
      const current = currentFields.Status?.name;
      if (current !== desiredStatus) {
        const opt = statusField.options.find((o) => o.name === desiredStatus);
        if (opt) {
          driftCount++;
          driftDetails.push(
            `#${issue.number}: Status ${current || "(none)"} → ${desiredStatus}`
          );
          if (!DRY_RUN) {
            setFieldValue(projectId, itemId, statusField.id, opt.id);
          }
        }
      }
    }
  }

  // Summary
  writeSummary("");
  writeSummary(`## Results`);
  writeSummary(`- Issues scanned: ${allIssues.length}`);
  writeSummary(`- Drift fixes: ${driftCount}`);
  writeSummary("");

  if (driftDetails.length > 0) {
    writeSummary("### Drift Details");
    writeSummary("");
    for (const d of driftDetails) {
      writeSummary(`- ${d}`);
    }
  } else {
    writeSummary("No drift detected.");
  }

  writeSummary("");
  writeSummary(`_Generated at ${new Date().toISOString()}_`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
