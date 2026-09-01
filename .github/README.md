# GitHub workflows

Pull requests run CI. A green PR may be merged by its developer or agent.

Every push to `main` deploys the Cloudflare hosted runtime to production through
`deploy-cloudflare-hosted.yml`, then runs its smoke checks. The same workflow can
be started manually for preview or production.

The retired AWS CDK deployment workflows were removed with the CDK application.
Secrets and non-secret deployment settings live in the `cloudflare-preview` and
`cloudflare-production` GitHub environments.
