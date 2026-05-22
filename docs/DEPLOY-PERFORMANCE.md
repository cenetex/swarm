# Deploy Performance

This repo keeps production releases on the GitHub Actions deploy path. The deploy workflow now routes tag releases based on the diff from the previous release tag so routine app-only changes avoid the slowest stacks.

## Release Routing

Tag releases still run the production deploy workflow. During setup, the workflow diffs the tag against the previous `v*` release tag.

App-only releases target `SwarmApi-prod` and skip the Admin UI build/deploy when every changed file is under one of these surfaces:

- `packages/handlers/src/`
- `packages/core/src/`
- `packages/mcp-server/src/`
- `packages/sticker-engine/src/`
- the package manifests for those packages
- `pnpm-lock.yaml`

Any infra, UI, docs, workflow, root workspace config, or mixed-surface change falls back to the full production deploy. This keeps the fast path conservative: it only applies when the release cannot change CloudFront UI assets, docs hosting, or CDK stack definitions outside the API stack.

## Lambda Hotpatch

Use the manual `Deploy Lambda Hotpatch` workflow for emergency handler-only code updates when all of the following are true:

- the change only affects Lambda handler code
- no ECS image change is required
- no CDK/CloudFormation change is required
- no package dependency, layer, UI, or docs change is required

The hotpatch path updates selected Lambda functions directly and does not replace the normal release process. Follow it with a regular tagged release so the deployed code, Git tag, CloudFormation state, and release notes converge again.

Do not use hotpatch for Discord gateway changes. Those run through the ECS image asset and require the normal CDK deploy path.

## Timing Visibility

The reusable CDK deploy workflow writes timing data to the GitHub step summary:

- package build time
- CDK diff/synth time
- CDK deploy command time
- asset image build/publish markers from CDK output
- CloudFormation event counts since deploy start
- ECS service stabilization time when an ECS service update occurs

Use this summary first when a release is slow. It separates local build/synth time, Docker asset work, CloudFormation update time, and ECS stabilization without requiring manual log scraping.
