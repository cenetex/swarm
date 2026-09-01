# Deploy performance

Production deploys use the Cloudflare hosted workflow. Every push to `main`
installs from the lockfile, validates the Admin UI and Worker, applies D1
migrations, deploys the Worker and static assets, and runs smoke checks.

The workflow uses one production concurrency group. Merges stay fast and
deployments remain ordered; there is no release tag, approval form, hold period,
or separate infrastructure ceremony.
