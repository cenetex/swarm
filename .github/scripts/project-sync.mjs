#!/usr/bin/env node
/**
 * project-sync.mjs
 *
 * Called by the project-sync workflow on issue/PR events.
 * 1. Adds the item to the GitHub Project (idempotent).
 * 2. Maps issue labels to project single-select fields (Priority, Status).
 * 3. Sets the milestone-derived "Target" iteration if the milestone matches
 *    the Roadmap naming convention (Roadmap: Now / Next / Later).
 *
 * Required env vars (set by the workflow):
 *   GH_TOKEN, PROJECT_OWNER (default "atimics"), PROJECT_NUMBER (default 1),
 *   ISSUE_NODE_ID, ISSUE_LABELS (JSON array of label name strings),
 *   ISSUE_MILESTONE (string), ISSUE_STATE (open|closed),
 *   EVENT_NAME (issues|pull_request), EVENT_ACTION, PR_MERGED
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

/** Map repo labels → Project Status field option names */
const STATUS_FROM_LABELS = {
  "status:in-progress": "In progress",
};

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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const nodeId = process.env.ISSUE_NODE_ID;
  const labels = JSON.parse(process.env.ISSUE_LABELS || "[]");
  const milestone = process.env.ISSUE_MILESTONE || "";
  const issueState = (process.env.ISSUE_STATE || "open").toLowerCase();
  const eventName = process.env.EVENT_NAME || "";
  const eventAction = process.env.EVENT_ACTION || "";
  const prMerged = process.env.PR_MERGED === "true";
  const issueNumber = process.env.ISSUE_NUMBER || "?";

  if (!nodeId) {
    console.log("No ISSUE_NODE_ID — skipping.");
    return;
  }

  console.log(`Processing #${issueNumber} (${eventName}/${eventAction})`);

  // 1. Add to project
  const projectId = getProjectId();
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

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
