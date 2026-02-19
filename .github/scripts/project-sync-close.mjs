#!/usr/bin/env node
/**
 * project-sync-close.mjs
 *
 * When a PR is merged, find issues referenced by closing keywords
 * (Closes #N, Fixes #N, Resolves #N) in the PR body and move them
 * to "Done" in the GitHub Project.
 *
 * Required env vars:
 *   GH_TOKEN, PR_NUMBER, PR_BODY
 */

import { execFileSync } from "node:child_process";

const PROJECT_OWNER = process.env.PROJECT_OWNER || "atimics";
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER || "1");

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

function getStatusFieldDone(projectId) {
  const res = graphql(`
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          field(name: "Status") {
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
  const opt = field.options.find((o) => o.name === "Done");
  return { fieldId: field.id, optionId: opt.id };
}

function getIssueNodeId(issueNumber) {
  try {
    const json = gh(["issue", "view", String(issueNumber), "--json", "id"]);
    return JSON.parse(json).id;
  } catch {
    return null;
  }
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const prNumber = process.env.PR_NUMBER || "?";
  const prBody = process.env.PR_BODY || "";

  // Extract issue numbers from closing keywords
  const closingPattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  const issueNumbers = new Set();
  let match;
  while ((match = closingPattern.exec(prBody)) !== null) {
    issueNumbers.add(Number(match[1]));
  }

  // Also check for the GitHub-native "Closing issues" via the API
  try {
    const prJson = gh(["pr", "view", String(prNumber), "--json", "closingIssuesReferences"]);
    const parsed = JSON.parse(prJson);
    if (parsed.closingIssuesReferences) {
      for (const ref of parsed.closingIssuesReferences) {
        issueNumbers.add(ref.number);
      }
    }
  } catch {
    // Not all `gh` versions support this field — fall back to regex only
  }

  if (issueNumbers.size === 0) {
    console.log(`PR #${prNumber}: no closing issue references found.`);
    return;
  }

  console.log(`PR #${prNumber} closes issues: ${[...issueNumbers].join(", ")}`);

  const projectId = getProjectId();
  const { fieldId, optionId } = getStatusFieldDone(projectId);

  for (const num of issueNumbers) {
    const nodeId = getIssueNodeId(num);
    if (!nodeId) {
      console.log(`  #${num}: could not resolve — skipping`);
      continue;
    }
    const itemId = addItemToProject(projectId, nodeId);
    setFieldValue(projectId, itemId, fieldId, optionId);
    console.log(`  #${num}: moved to Done`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
