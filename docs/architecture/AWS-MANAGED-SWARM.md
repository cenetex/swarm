# AWS Managed Swarm

> Legacy/specialized runtime option. The default paid hosted tier now targets the shared Cloudflare hybrid described in `CLOUDFLARE-HOSTED-SWARM.md`.

This design remains available if measured workloads require a managed container pool. Users still choose only **Local** or **Hosted**; the underlying provider is never a product-level choice.

## Product Model

### Local

- Runs while the app is open.
- Uses local SQLite, local encrypted secrets, and local runtime supervision.
- Good for free use, development, privacy-first workflows, and self-hosting.

### Hosted

- $9/month starter plan.
- Runs as an isolated managed Swarm instance on our shared AWS EC2 pool.
- Users do not see EC2, AMIs, security groups, runtime endpoints, shell commands, or provider keys.
- The UI requests hosting; the backend records an AWS managed-instance request and later the AWS control plane attaches a running endpoint.

## AWS Shape

| Need | AWS Shape | Notes |
| --- | --- | --- |
| Control plane | Existing Swarm API and billing | Owns auth, Stripe entitlement, and hosted instance records. |
| Runtime pool | EC2 Auto Scaling group | Graviton instances run multiple isolated Swarm runtime containers. |
| Tenant routing | Shared ingress | Avoid one public IPv4 per customer; route through shared ingress or tunnel. |
| State | Existing DynamoDB/local adapter contract | Hosted state should reuse the hosted platform contract. |
| Blobs | S3/CloudFront or existing blob adapter | Keep media out of container disks. |
| Secrets | AWS Secrets Manager plus user-secret encryption | No provider keys in the browser. |
| Logs | CloudWatch with short retention | Keep per-avatar logs bounded. |
| Sandbox compute | Ascii Box | Use for bursty Linux/code/browser machines, not the always-on $9 tier. |

## Guardrails

- Do not provision one public EC2 instance or public IPv4 per $9 customer.
- Do not route the starter plan through ECS/Fargate by default; always-on per-tenant Fargate is too expensive for the target price.
- Use shared EC2 capacity with hard per-tenant CPU, memory, disk, network, and log limits.
- Keep customer-visible language as Local vs Hosted. AWS stays internal.
- Treat Ascii Box as an optional compute provider for runtime experiments and sandboxes.

## First Slice In This Repo

- `@swarm/core` now describes the AWS managed EC2-pool hosted plan.
- The local API exposes AWS-managed hosted status and persists a managed-instance request.
- The Settings UI can start/sync hosted service and shows the hosted request status.
- The actual AWS provisioner remains a follow-up: it should consume hosted requests, place runtime containers on the EC2 pool, attach ingress, and update the hosted instance endpoint/status.
