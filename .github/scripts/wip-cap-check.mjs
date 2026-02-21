#!/usr/bin/env node
/**
 * wip-cap-check.mjs
 *
 * Enforces P0 Work-In-Progress cap policy during project reconciliation.
 * - Counts active priority:high + Roadmap: Now issues.
 * - Reports current WIP count vs configured cap.
 * - Produces demotion candidate list when cap is exceeded.
 * - Flags expired wip-cap:override labels.
 *
 * Required env vars (set by the workflow):
 *   GH_TOKEN
 *
 * Optional env vars:
 *   DRY_RUN          - "true" to report only, no mutations (default: "false")
 *   WIP_CAP_OVERRIDE - integer to override configured cap (e.g. for incidents)
 *   GITHUB_STEP_SUMMARY - path to summary file (set by Actions)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DRY_RUN = process.env.DRY_RUN === "true";
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || "";
const WIP_CAP_OVERRIDE = process.env.WIP_CAP_OVERRIDE
  ? Number(process.env.WIP_CAP_OVERRIDE)
  : null;

const MAX_GH_RETRIES = Number(process.env.PROJECT_SYNC_GH_MAX_RETRIES || "5");
const BASE_BACKOFF_MS = Number(process.env.PROJECT_SYNC_GH_BACKOFF_MS || "1200");

// ── Helpers (same patterns as project-sync-reconcile.mjs) ──────────────────

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

function writeSummary(text) {
  console.log(text);
  if (!SUMMARY_FILE) return;

  try {
    appendFileSync(SUMMARY_FILE, `${text}\n`);
  } catch {
    // ignore outside Actions
  }
}

function loadPolicy() {
  const policyPath = resolve(__dirname, "../policy/wip-cap-policy.json");
  return JSON.parse(readFileSync(policyPath, "utf-8"));
}

// ── Core Logic ─────────────────────────────────────────────────────────────

function fetchOpenIssues() {
  const json = gh([
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,title,labels,milestone,createdAt,updatedAt",
  ]);
  return JSON.parse(json);
}

function fetchOpenPRs() {
  try {
    const json = gh([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,headRefName,body,isDraft",
    ]);
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function issueHasOpenPR(issueNumber, openPRs) {
  const branchRe = /issue-(\d+)/;
  const closingRe = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

  for (const pr of openPRs) {
    const branchMatch = pr.headRefName?.match(branchRe);
    if (branchMatch && Number(branchMatch[1]) === issueNumber) {
      return true;
    }

    if (pr.body) {
      let match;
      const re = new RegExp(closingRe.source, closingRe.flags);
      while ((match = re.exec(pr.body)) !== null) {
        if (Number(match[1]) === issueNumber) return true;
      }
    }
  }

  return false;
}

function isOverrideExpired(issue, maxDurationHours) {
  const overrideLabel = (issue.labels || []).find(
    (l) => l.name === "wip-cap:override",
  );
  if (!overrideLabel) return false;

  // Check issue updatedAt as proxy for when override was applied
  // (GitHub does not expose label-added timestamps via REST)
  const updatedAt = new Date(issue.updatedAt);
  const now = new Date();
  const hoursElapsed = (now - updatedAt) / (1000 * 60 * 60);

  // Only flag as expired if the issue hasn't been updated within the window.
  // This is a conservative heuristic; the label could have been applied at any
  // time before updatedAt.
  return hoursElapsed > maxDurationHours;
}

function classifyIssues(issues, capConfig, openPRs, overrideConfig) {
  const active = [];
  const overridden = [];
  const overrideExpired = [];

  for (const issue of issues) {
    const labels = (issue.labels || []).map((l) => l.name);
    const milestone = (issue.milestone?.title || "").trim();

    // Must have the priority label
    if (!labels.includes(capConfig.label)) continue;

    // Must be in the active milestone
    if (milestone.toLowerCase() !== capConfig.activeMilestone.toLowerCase()) continue;

    // Check for override
    if (labels.includes(overrideConfig.label)) {
      if (isOverrideExpired(issue, overrideConfig.maxDurationHours)) {
        overrideExpired.push(issue);
      } else {
        overridden.push(issue);
      }
      continue;
    }

    // Exclude issues in excluded statuses (determined by labels)
    const isBlocked = labels.includes("status:blocked");
    if (isBlocked && capConfig.excludeStatuses.includes("Blocked")) continue;

    active.push(issue);
  }

  return { active, overridden, overrideExpired };
}

function rankDemotionCandidates(active, openPRs) {
  const enriched = active.map((issue) => {
    const labels = (issue.labels || []).map((l) => l.name);
    return {
      ...issue,
      isBlocked: labels.includes("status:blocked"),
      hasOpenPR: issueHasOpenPR(issue.number, openPRs),
      ageMs: Date.now() - new Date(issue.createdAt).getTime(),
    };
  });

  // Sort: blocked first (good demotion candidates), then no-PR, then newest
  enriched.sort((a, b) => {
    // Blocked issues are better demotion candidates
    if (a.isBlocked !== b.isBlocked) return a.isBlocked ? -1 : 1;
    // Issues without PRs are better demotion candidates
    if (a.hasOpenPR !== b.hasOpenPR) return a.hasOpenPR ? 1 : -1;
    // Newest issues are better demotion candidates (less invested work)
    return a.ageMs - b.ageMs;
  });

  return enriched;
}

function formatAge(ms) {
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return "<1d";
  return `${days}d`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const policy = loadPolicy();

  writeSummary("# P0 WIP Cap Enforcement Report");
  writeSummary("");
  writeSummary(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  writeSummary("");

  const issues = fetchOpenIssues();
  const openPRs = fetchOpenPRs();

  console.log(`Fetched ${issues.length} open issues, ${openPRs.length} open PRs`);

  let exitCode = 0;

  for (const [tier, capConfig] of Object.entries(policy.caps)) {
    const effectiveCap = WIP_CAP_OVERRIDE ?? capConfig.maxActive;
    const { active, overridden, overrideExpired } = classifyIssues(
      issues,
      capConfig,
      openPRs,
      policy.override,
    );

    const activeCount = active.length;
    const exceeded = activeCount > effectiveCap;
    const overCount = activeCount - effectiveCap;

    writeSummary(`## ${tier} WIP Status`);
    writeSummary("");
    writeSummary(`| Metric | Value |`);
    writeSummary(`|--------|-------|`);
    writeSummary(`| Active ${tier} issues | **${activeCount}** |`);
    writeSummary(`| Configured cap | ${capConfig.maxActive} |`);
    if (WIP_CAP_OVERRIDE !== null) {
      writeSummary(`| Override cap (env) | ${WIP_CAP_OVERRIDE} |`);
    }
    writeSummary(`| Effective cap | ${effectiveCap} |`);
    writeSummary(`| Status | ${exceeded ? `**EXCEEDED** (over by ${overCount})` : "OK"} |`);
    writeSummary(`| Overridden issues | ${overridden.length} |`);
    writeSummary(`| Expired overrides | ${overrideExpired.length} |`);
    writeSummary("");

    // List active issues
    if (active.length > 0) {
      writeSummary(`### Active ${tier} Issues`);
      writeSummary("");
      writeSummary("| # | Title | Age | Has PR |");
      writeSummary("|---|-------|-----|--------|");
      for (const issue of active) {
        const age = formatAge(Date.now() - new Date(issue.createdAt).getTime());
        const hasPR = issueHasOpenPR(issue.number, openPRs) ? "Yes" : "No";
        writeSummary(`| #${issue.number} | ${issue.title} | ${age} | ${hasPR} |`);
      }
      writeSummary("");
    }

    // Flag expired overrides
    if (overrideExpired.length > 0) {
      writeSummary(`### Expired Override Warnings`);
      writeSummary("");
      for (const issue of overrideExpired) {
        writeSummary(
          `- **#${issue.number}** (${issue.title}): \`wip-cap:override\` may have exceeded ${policy.override.maxDurationHours}h window. Review and remove or re-apply.`,
        );
      }
      writeSummary("");
    }

    // Overridden issues (informational)
    if (overridden.length > 0) {
      writeSummary(`### Overridden Issues (exempt from cap)`);
      writeSummary("");
      for (const issue of overridden) {
        writeSummary(`- #${issue.number}: ${issue.title}`);
      }
      writeSummary("");
    }

    // Demotion candidates when cap exceeded
    if (exceeded) {
      const ranked = rankDemotionCandidates(active, openPRs);
      const candidates = ranked.slice(0, overCount);

      writeSummary(`### Demotion Candidates`);
      writeSummary("");
      writeSummary(
        `The following ${candidates.length} issue(s) are recommended for demotion to **${policy.demotion.targetMilestone}**:`,
      );
      writeSummary("");
      writeSummary("| # | Title | Age | Blocked | Has PR | Rationale |");
      writeSummary("|---|-------|-----|---------|--------|-----------|");

      for (const c of candidates) {
        const age = formatAge(c.ageMs);
        const rationale = [];
        if (c.isBlocked) rationale.push("blocked");
        if (!c.hasOpenPR) rationale.push("no open PR");
        if (c.ageMs < 7 * 24 * 60 * 60 * 1000) rationale.push("recently created");

        writeSummary(
          `| #${c.number} | ${c.title} | ${age} | ${c.isBlocked ? "Yes" : "No"} | ${c.hasOpenPR ? "Yes" : "No"} | ${rationale.join(", ") || "lowest rank"} |`,
        );
      }

      writeSummary("");
      writeSummary(
        `> To override during an incident, apply the \`${policy.override.label}\` label to exempt issues. Overrides expire after ${policy.override.maxDurationHours} hours.`,
      );
      writeSummary("");

      exitCode = 1;

      // Emit GitHub Actions annotations
      if (process.env.GITHUB_ACTIONS) {
        console.log(
          `::warning::P0 WIP cap exceeded: ${activeCount}/${effectiveCap} active. ${candidates.length} demotion candidate(s) identified.`,
        );
      }
    }
  }

  writeSummary("---");
  writeSummary(`_Generated at ${new Date().toISOString()}_`);

  if (exitCode !== 0 && !DRY_RUN) {
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
