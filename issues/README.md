# Issues + Agent Registry

This folder tracks issues and agent assignments in JSON to support automated tooling.

## Agent Registry
Agents must register before starting work.

File: `issues/agents.json`

Entry format:
```json
{
  "codename": "agent-fox",
  "role": "dev",
  "issueId": "ISSUE-0001",
  "status": "active",
  "notes": "Working on tool tagging pipeline",
  "startedAt": "2026-01-13T09:00:00Z"
}
```

- `role`: `dev` or `qa`
- `issueId`: must match an issue file in `/issues/staging`

## Issue Files
Store each issue as a JSON file under `issues/staging/`.

Suggested format:
```json
{
  "id": "ISSUE-0001",
  "title": "Tool tagging engine",
  "status": "open",
  "owner": "agent-fox",
  "tags": ["tools", "mcp"],
  "summary": "Add tag metadata and filtering rules",
  "acceptance": ["Tag filtering respects platform", "Toolsets cap at 3"],
  "notes": "" 
}
```

Keep issues short; link to docs or PRs for deeper context.
