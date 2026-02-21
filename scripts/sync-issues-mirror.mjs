#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = process.env.ISSUES_REPO || 'cenetex/aws-swarm';
const outputPath = resolve('issues', 'GITHUB-OPEN-ISSUES.md');

function run(command) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fmtDate(value) {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}

try {
  const raw = run(`gh issue list --repo ${repo} --state open --limit 300 --json number,title,labels,url,createdAt,updatedAt,assignees`);
  const issues = JSON.parse(raw);

  issues.sort((a, b) => {
    const pa = (a.labels || []).map((l) => l.name).find((n) => n.startsWith('priority:')) || 'priority:zzz';
    const pb = (b.labels || []).map((l) => l.name).find((n) => n.startsWith('priority:')) || 'priority:zzz';
    if (pa !== pb) return pa.localeCompare(pb);
    return a.number - b.number;
  });

  const lines = [];
  lines.push('# GitHub Open Issues Mirror');
  lines.push('');
  lines.push(`- Source of truth: https://github.com/${repo}/issues`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Open issues: ${issues.length}`);
  lines.push('');
  lines.push('> This file is read-only mirror output. Do not edit issue lifecycle state here.');
  lines.push('');
  lines.push('| # | Title | Priority | Labels | Assignees | Updated |');
  lines.push('|---:|---|---|---|---|---|');

  for (const issue of issues) {
    const labelNames = (issue.labels || []).map((l) => l.name);
    const priority = labelNames.find((n) => n.startsWith('priority:')) || '';
    const assignees = (issue.assignees || []).map((a) => a.login).join(', ');
    const labels = labelNames.filter((n) => !n.startsWith('priority:')).join(', ');
    const title = String(issue.title).replaceAll('|', '\\|');
    lines.push(`| [#${issue.number}](${issue.url}) | ${title} | ${priority} | ${labels} | ${assignees} | ${fmtDate(issue.updatedAt)} |`);
  }

  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`Wrote ${outputPath} (${issues.length} issues)\n`);
} catch (error) {
  process.stderr.write('Failed to sync issue mirror. Ensure gh CLI is authenticated.\n');
  process.stderr.write(String(error?.message || error));
  process.stderr.write('\n');
  process.exit(1);
}
