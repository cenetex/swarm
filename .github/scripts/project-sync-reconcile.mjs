#!/usr/bin/env node
/**
 * project-sync-reconcile.mjs
 *
 * Nightly reconciliation job. Walks open and recently closed issues and ensures
 * project fields are aligned (Priority, Status, Iteration).
 * - status:blocked label maps to Status="Blocked" when available.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const PROJECT_OWNER = process.env.PROJECT_OWNER || "cenetex";
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER || "1");
const DRY_RUN = process.env.DRY_RUN === "true";
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || "";

const MAX_GH_RETRIES = Number(process.env.PROJECT_SYNC_GH_MAX_RETRIES || "5");
const BASE_BACKOFF_MS = Number(process.env.PROJECT_SYNC_GH_BACKOFF_MS || "1200");

const PRIORITY_MAP = {
  "priority:high": "P0",
  "priority:medium": "P1",
  "priority:low": "P2",
};

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
      return execFileSync("gh", args, {
        encoding: "utf-8",
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
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

function writeSummary(text) {
  console.log(text);
  if (!SUMMARY_FILE) return;

  try {
    appendFileSync(SUMMARY_FILE, `${text}\n`);
  } catch {
    // ignore outside Actions
  }
}

function getProjectId() {
  const res = graphql(
    `
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) { id }
      }
    }
  `,
    { owner: PROJECT_OWNER, number: PROJECT_NUMBER },
  );

  return res.data.user.projectV2.id;
}

function getSingleSelectFieldMeta(projectId, fieldName) {
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

  return res.data.node.field || null;
}

function getIterationFieldMeta(projectId) {
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

  return res.data.node.field || null;
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

function resolveStatusWithFallback(statusField, desiredStatus) {
  if (!statusField?.options?.length || !desiredStatus) return null;

  const direct = statusField.options.find((opt) => opt.name === desiredStatus);
  if (direct) {
    return { name: desiredStatus, optionId: direct.id, fallback: false };
  }

  if (desiredStatus === "In review") {
    const fallback = statusField.options.find((opt) => opt.name === "In progress");
    if (fallback) {
      return { name: "In progress", optionId: fallback.id, fallback: true };
    }
  }

  return null;
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

function resolveIterationFromMilestone(iterationField, milestoneTitle) {
  const normalized = String(milestoneTitle || "").trim().toLowerCase();
  if (!iterationField) return { action: "skip" };
  if (!normalized || normalized === "roadmap: later") return { action: "clear" };
  if (normalized !== "roadmap: now" && normalized !== "roadmap: next") return { action: "skip" };

  const liveIterations = iterationField.configuration?.iterations || [];
  const { currentIteration, nextIteration } = resolveCurrentAndNextIterations(liveIterations);

  if (normalized === "roadmap: now") {
    return currentIteration
      ? { action: "set", id: currentIteration.id, title: currentIteration.title }
      : { action: "skip" };
  }

  return nextIteration
    ? { action: "set", id: nextIteration.id, title: nextIteration.title }
    : { action: "skip" };
}

function getItemFields(itemId) {
  const res = graphql(
    `
    query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field { ... on ProjectV2SingleSelectField { name } }
                name
                optionId
              }
              ... on ProjectV2ItemFieldIterationValue {
                field { ... on ProjectV2IterationField { name } }
                title
                iterationId
              }
            }
          }
        }
      }
    }
  `,
    { itemId },
  );

  const fields = {};
  for (const node of res.data.node.fieldValues?.nodes || []) {
    if (!node.field?.name) continue;

    if (node.optionId && node.name) {
      fields[node.field.name] = { name: node.name, optionId: node.optionId };
      continue;
    }

    if (node.iterationId && node.title) {
      fields[node.field.name] = { name: node.title, iterationId: node.iterationId };
    }
  }

  return fields;
}

async function main() {
  writeSummary("# Project Sync Reconciliation Report");
  writeSummary("");
  writeSummary(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  writeSummary("");

  const issuesJson = gh([
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,title,labels,milestone,id,state",
  ]);
  const openIssues = JSON.parse(issuesJson);

  const closedJson = gh([
    "issue",
    "list",
    "--state",
    "closed",
    "--limit",
    "100",
    "--json",
    "number,title,labels,milestone,id,state",
  ]);
  const closedIssues = JSON.parse(closedJson);
  const allIssues = [...openIssues, ...closedIssues];

  console.log(`Found ${openIssues.length} open issues`);
  console.log(`Including ${closedIssues.length} recently closed issues`);

  const projectId = getProjectId();
  const priorityField = getSingleSelectFieldMeta(projectId, "Priority");
  const statusField = getSingleSelectFieldMeta(projectId, "Status");
  const iterationField = getIterationFieldMeta(projectId);

  let driftCount = 0;
  const driftDetails = [];

  for (const issue of allIssues) {
    const labels = (issue.labels || []).map((label) => label.name);
    const issueState = (issue.state || "open").toLowerCase();

    let itemId;
    try {
      itemId = addItemToProject(projectId, issue.id);
    } catch (error) {
      console.log(`  #${issue.number}: failed to add — ${error.message}`);
      continue;
    }

    const currentFields = getItemFields(itemId);

    let desiredPriority = null;
    for (const [label, optionName] of Object.entries(PRIORITY_MAP)) {
      if (labels.includes(label)) {
        desiredPriority = optionName;
        break;
      }
    }

    let desiredStatus = null;
    if (issueState === "closed") {
      desiredStatus = "Done";
    } else if (labels.includes("status:blocked")) {
      desiredStatus = "Blocked";
    } else if (labels.includes("status:in-progress")) {
      desiredStatus = "In progress";
    } else {
      desiredStatus = "Todo";
    }

    let desiredIteration = { action: "skip" };
    if (issueState !== "closed") {
      desiredIteration = resolveIterationFromMilestone(iterationField, issue.milestone?.title);
    }

    if (desiredPriority && priorityField?.options?.length) {
      const current = currentFields.Priority?.name;
      if (current !== desiredPriority) {
        const option = priorityField.options.find((opt) => opt.name === desiredPriority);
        if (option) {
          driftCount += 1;
          driftDetails.push(`#${issue.number}: Priority ${current || "(none)"} -> ${desiredPriority}`);
          if (!DRY_RUN) {
            setSingleSelectFieldValue(projectId, itemId, priorityField.id, option.id);
          }
        }
      }
    }

    if (desiredStatus) {
      const current = currentFields.Status?.name;
      const resolvedStatus = resolveStatusWithFallback(statusField, desiredStatus);

      if (!resolvedStatus) {
        console.log(`  #${issue.number}: Status '${desiredStatus}' not available — skipping`);
      } else if (current !== resolvedStatus.name) {
        driftCount += 1;
        const suffix = resolvedStatus.fallback ? " (fallback from In review)" : "";
        driftDetails.push(
          `#${issue.number}: Status ${current || "(none)"} -> ${resolvedStatus.name}${suffix}`,
        );
        if (!DRY_RUN) {
          setSingleSelectFieldValue(projectId, itemId, statusField.id, resolvedStatus.optionId);
        }
      }
    }

    if (desiredIteration.action === "set" && iterationField) {
      const currentIterationId = currentFields.Iteration?.iterationId || null;
      if (currentIterationId !== desiredIteration.id) {
        driftCount += 1;
        driftDetails.push(
          `#${issue.number}: Iteration ${currentFields.Iteration?.name || "(none)"} -> ${desiredIteration.title}`,
        );
        if (!DRY_RUN) {
          setIterationFieldValue(projectId, itemId, iterationField.id, desiredIteration.id);
        }
      }
    }

    if (desiredIteration.action === "clear" && iterationField) {
      const currentIterationId = currentFields.Iteration?.iterationId || null;
      if (currentIterationId) {
        driftCount += 1;
        driftDetails.push(
          `#${issue.number}: Iteration ${currentFields.Iteration?.name || "(none)"} -> (none)`,
        );
        if (!DRY_RUN) {
          clearFieldValue(projectId, itemId, iterationField.id);
        }
      }
    }
  }

  writeSummary("");
  writeSummary("## Results");
  writeSummary(`- Issues scanned: ${allIssues.length}`);
  writeSummary(`- Drift fixes: ${driftCount}`);
  writeSummary("");

  if (driftDetails.length > 0) {
    writeSummary("### Drift Details");
    writeSummary("");
    for (const detail of driftDetails) {
      writeSummary(`- ${detail}`);
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
