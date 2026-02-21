#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_CONFIG_PATH = '.github/policy/internal-issue-sync-policy.json';
const DEFAULT_OUTPUT_DIR = 'test-outputs/internal-issues-sync';
const DEFAULT_FALLBACK_ISSUES_DIR = 'issues/staging';

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG_PATH,
    limit: undefined,
    status: undefined,
    dryRun: undefined,
    outputPath: undefined,
    source: undefined,
    sourceDir: undefined,
    fallbackToFiles: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config' && argv[index + 1]) {
      args.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--limit' && argv[index + 1]) {
      args.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--status' && argv[index + 1]) {
      args.status = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--output' && argv[index + 1]) {
      args.outputPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--apply') {
      args.dryRun = false;
      continue;
    }
    if (token === '--source' && argv[index + 1]) {
      args.source = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--source-dir' && argv[index + 1]) {
      args.sourceDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--fallback-to-files') {
      args.fallbackToFiles = true;
      continue;
    }
    if (token === '--no-fallback-to-files') {
      args.fallbackToFiles = false;
      continue;
    }
  }

  return args;
}

function run(command) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runMaybe(command) {
  try {
    return run(command);
  } catch {
    return '';
  }
}

function parseRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repository value '${repo}'. Expected owner/name.`);
  }
  return { owner, name };
}

function normalizeLabelList(labels) {
  return [...new Set((labels || []).map((label) => String(label).trim()).filter(Boolean))];
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function loadConfig(configPath) {
  const absolutePath = resolve(configPath);
  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  return { absolutePath, config: parsed };
}

function getApiUrl() {
  return process.env.SWARM_ADMIN_API_URL || process.env.API_URL || '';
}

function getInternalTestKey() {
  return process.env.SWARM_INTERNAL_TEST_KEY || process.env.INTERNAL_TEST_KEY || '';
}

async function fetchInternalIssues({ apiUrl, internalTestKey, status, limit }) {
  const url = new URL('/issues', apiUrl);
  if (status) {
    url.searchParams.set('status', status);
  }
  if (Number.isFinite(limit) && limit > 0) {
    url.searchParams.set('limit', String(limit));
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': internalTestKey,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch internal issues (${response.status}): ${text}`);
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.issues)) {
    throw new Error('Internal issues response missing issues array.');
  }

  return parsed.issues;
}

function mapPriorityToSeverity(priority) {
  const normalized = String(priority || '').toUpperCase();
  if (normalized === 'P0') return 'critical';
  if (normalized === 'P1') return 'high';
  if (normalized === 'P2') return 'medium';
  if (normalized === 'P3') return 'low';
  return 'medium';
}

function mapFileIssueToInternalShape(issue, sourceFile) {
  const tags = Array.isArray(issue.tags) ? issue.tags : [];
  const category = tags.includes('feature') || tags.includes('enhancement')
    ? 'feature_request'
    : 'error';

  const subsystem = tags.find((tag) => ['telegram', 'chat', 'llm', 'state', 'webhook'].includes(String(tag))) || 'chat';
  const now = Date.now();

  return {
    issueId: String(issue.id || sourceFile.replace(/\.json$/i, '').toLowerCase()),
    title: String(issue.title || issue.summary || 'Internal issue'),
    description: String(issue.summary || issue.notes || ''),
    status: String(issue.status || 'open'),
    severity: mapPriorityToSeverity(issue.priority),
    category,
    subsystem,
    occurrenceCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    metadata: {
      source: 'file',
      sourceFile,
      priority: issue.priority,
      milestone: issue.milestone,
      tags,
    },
  };
}

function fetchInternalIssuesFromFiles(sourceDir, limit) {
  const resolvedDir = resolve(sourceDir);
  const files = readdirSync(resolvedDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();

  const selected = Number.isFinite(limit) && limit > 0 ? files.slice(0, limit) : files;

  return selected.map((name) => {
    const fullPath = resolve(resolvedDir, name);
    const raw = readFileSync(fullPath, 'utf8');
    const parsed = JSON.parse(raw);
    return mapFileIssueToInternalShape(parsed, name);
  });
}

function findExistingGitHubIssue(repo, marker) {
  const escaped = marker.replaceAll('"', '\\"');
  const output = runMaybe(`gh issue list --repo ${repo} --state all --search "\"${escaped}\" in:body" --limit 5 --json number,title,state,url,assignees`);
  if (!output) {
    return null;
  }
  const list = JSON.parse(output);
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  return list[0];
}

function buildLabels(issue, config) {
  const defaults = config.defaults || {};
  const severityRules = config.severityRules || {};
  const categoryRules = config.categoryRules || {};
  const subsystemRules = config.subsystemRules || {};

  const severityRule = severityRules[issue.severity] || {};
  const categoryRule = categoryRules[issue.category] || {};
  const subsystemRule = subsystemRules[issue.subsystem] || {};

  return normalizeLabelList([
    ...(defaults.labels || []),
    ...(severityRule.labels || []),
    ...(categoryRule.labels || []),
    ...(subsystemRule.labels || []),
  ]);
}

function shouldAssignCopilot(issue, config) {
  const defaults = config.defaults || {};
  const severityRules = config.severityRules || {};
  const categoryRules = config.categoryRules || {};

  const severityRule = severityRules[issue.severity] || {};
  const categoryRule = categoryRules[issue.category] || {};

  const severityOverride = severityRule.assignCopilot;
  const categoryOverride = categoryRule.assignCopilot;

  if (typeof categoryOverride === 'boolean') {
    return categoryOverride;
  }
  if (typeof severityOverride === 'boolean') {
    return severityOverride;
  }
  return Boolean(defaults.assignCopilot);
}

function buildIssueTitle(issue, config) {
  const titlePrefix = config.defaults?.titlePrefix || '[auto-issue]';
  return `${titlePrefix}[${issue.severity}] ${issue.title}`;
}

function buildIssueBody(issue, config, marker) {
  const sourceLabel = config.defaults?.sourceLabel || 'internal-issues';
  const details = [
    `- Internal issueId: ${issue.issueId}`,
    `- Fingerprint: ${issue.fingerprint || 'n/a'}`,
    `- Severity: ${issue.severity || 'unknown'}`,
    `- Status: ${issue.status || 'open'}`,
    `- Category: ${issue.category || 'error'}`,
    `- Subsystem: ${issue.subsystem || 'unknown'}`,
    `- Occurrence count: ${issue.occurrenceCount || 0}`,
    `- First seen: ${issue.firstSeenAt ? new Date(issue.firstSeenAt).toISOString() : 'n/a'}`,
    `- Last seen: ${issue.lastSeenAt ? new Date(issue.lastSeenAt).toISOString() : 'n/a'}`,
  ];

  if (issue.avatarId) {
    details.push(`- Avatar: ${issue.avatarId}`);
  }

  const description = issue.description || issue.sampleError || 'No description provided.';

  return [
    marker,
    `<!-- source:${sourceLabel} -->`,
    '',
    '## Summary',
    '',
    description,
    '',
    '## Internal Context',
    '',
    ...details,
    '',
    '## Notes',
    '',
    '- This issue was synchronized from internal auto-issues intake.',
    '- Update status here and in internal issue tracking if operationally needed.',
  ].join('\n');
}

function createGitHubIssue({ repo, title, body, labels }) {
  const bodyPath = join(tmpdir(), `internal-issue-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  writeFileSync(bodyPath, body, 'utf8');

  const labelArgs = labels.map((label) => `--label "${label.replaceAll('"', '\\"')}"`).join(' ');
  const command = `gh issue create --repo ${repo} --title "${title.replaceAll('"', '\\"')}" --body-file "${bodyPath}" ${labelArgs}`;
  const issueUrl = run(command);
  const numberMatch = issueUrl.match(/\/(\d+)$/);
  const issueNumber = numberMatch ? Number(numberMatch[1]) : null;

  return {
    issueUrl,
    issueNumber,
  };
}

function assignCopilot({ repo, issueNumber }) {
  if (!issueNumber) {
    return;
  }
  const { owner, name } = parseRepo(repo);
  run(`GH_REPO_OWNER=${owner} GH_REPO_NAME=${name} scripts/gh-assign-copilot.sh ${issueNumber}`);
}

function writeSummary(summary, outputPath) {
  const resolvedOutputPath = outputPath
    ? resolve(outputPath)
    : resolve(DEFAULT_OUTPUT_DIR, `summary-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);

  mkdirSync(resolve(DEFAULT_OUTPUT_DIR), { recursive: true });
  writeFileSync(resolvedOutputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  return resolvedOutputPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { absolutePath: configPath, config } = loadConfig(args.configPath);

  const repo = process.env.ISSUES_REPO || config.defaults?.repo || 'cenetex/aws-swarm';
  const markerPrefix = config.defaults?.markerPrefix || 'internal-issue-sync:id=';
  const status = args.status || process.env.INTERNAL_ISSUE_STATUS || config.defaults?.status || 'open';
  const limit = Number.isFinite(args.limit)
    ? args.limit
    : Number(process.env.INTERNAL_ISSUE_LIMIT || config.defaults?.limit || 100);
  const source = args.source || process.env.INTERNAL_ISSUE_SOURCE || 'api';
  const sourceDir = args.sourceDir || process.env.INTERNAL_ISSUE_SOURCE_DIR || DEFAULT_FALLBACK_ISSUES_DIR;
  const fallbackToFiles = typeof args.fallbackToFiles === 'boolean'
    ? args.fallbackToFiles
    : envBool('INTERNAL_ISSUE_FALLBACK_TO_FILES', true);

  const dryRun = typeof args.dryRun === 'boolean'
    ? args.dryRun
    : envBool('INTERNAL_ISSUE_SYNC_DRY_RUN', config.defaults?.dryRun !== false);

  const apiUrl = getApiUrl();
  const internalTestKey = getInternalTestKey();

  let sourceMode = source;
  let internalIssues = [];

  if (source === 'files') {
    internalIssues = fetchInternalIssuesFromFiles(sourceDir, limit);
    sourceMode = `files:${resolve(sourceDir)}`;
  } else {
    if (!apiUrl) {
      throw new Error('Missing SWARM_ADMIN_API_URL (or API_URL).');
    }
    if (!internalTestKey) {
      throw new Error('Missing SWARM_INTERNAL_TEST_KEY (or INTERNAL_TEST_KEY).');
    }

    try {
      internalIssues = await fetchInternalIssues({
        apiUrl,
        internalTestKey,
        status,
        limit,
      });
      sourceMode = 'api';
    } catch (error) {
      if (!fallbackToFiles) {
        throw error;
      }
      internalIssues = fetchInternalIssuesFromFiles(sourceDir, limit);
      sourceMode = `files-fallback:${resolve(sourceDir)}`;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    configPath,
    repo,
    apiUrl,
    status,
    limit,
    dryRun,
    sourceMode,
    fetched: internalIssues.length,
    created: 0,
    skippedExisting: 0,
    copilotAssigned: 0,
    errors: 0,
    actions: [],
  };

  for (const issue of internalIssues) {
    const marker = `${markerPrefix}${issue.issueId}`;
    const existing = findExistingGitHubIssue(repo, marker);

    if (existing) {
      summary.skippedExisting += 1;
      summary.actions.push({
        issueId: issue.issueId,
        action: 'skip-existing',
        githubIssueNumber: existing.number,
        githubIssueUrl: existing.url,
      });
      continue;
    }

    const labels = buildLabels(issue, config);
    const assign = shouldAssignCopilot(issue, config);
    const title = buildIssueTitle(issue, config);
    const body = buildIssueBody(issue, config, marker);

    if (dryRun) {
      summary.actions.push({
        issueId: issue.issueId,
        action: 'would-create',
        title,
        labels,
        assignCopilot: assign,
      });
      continue;
    }

    try {
      const created = createGitHubIssue({ repo, title, body, labels });
      summary.created += 1;

      if (assign && created.issueNumber) {
        assignCopilot({ repo, issueNumber: created.issueNumber });
        summary.copilotAssigned += 1;
      }

      summary.actions.push({
        issueId: issue.issueId,
        action: 'created',
        githubIssueNumber: created.issueNumber,
        githubIssueUrl: created.issueUrl,
        labels,
        assignCopilot: assign,
      });
    } catch (error) {
      summary.errors += 1;
      summary.actions.push({
        issueId: issue.issueId,
        action: 'error',
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }

  const summaryPath = writeSummary(summary, args.outputPath);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`Summary written to ${summaryPath}\n`);

  if (summary.errors > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
});
