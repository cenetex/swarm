# Portable Avatar Recovery

Use this runbook when a Swarm runtime, D1 database, R2 bucket, or whole cloud account is unavailable or has been deleted.

## Prepare before an incident

For every avatar that matters:

1. Open **Studio** and select the avatar.
2. Choose **Download** and keep the `.swarm-avatar.json` file outside the Swarm cloud account.
3. Record the displayed `sha256:...` revision ID with the file.
4. For public infrastructure, upload the exact file to permanent content-addressed storage such as Arweave and keep its URI.
5. If an NFT represents ownership, make its metadata point to that permanent URI and include the same avatar ID, revision ID, schema, and SHA-256 digest.
6. Keep credentials in a separate password or secret manager. They are intentionally absent from the artifact.

Keep at least two copies in separate fault domains. R2 alone is a hosted mirror, not disaster recovery.

## Verify an artifact

The downloaded API response is canonical JSON. Hash the exact file bytes:

```bash
shasum -a 256 my-avatar.swarm-avatar.json
```

The result must equal the hex part of the recorded `sha256:<hex>` revision ID. Do not import a file when the digest differs from the trusted record or NFT metadata.

## Restore through Studio

1. Open a clean Swarm environment.
2. Sign in with the Solana wallet named in `identity.controller.address` inside the artifact.
3. Open **Studio**. Connecting OpenRouter is not required to restore the project.
4. Choose **Restore from portable artifact** and select the JSON file.
5. Confirm that the avatar name, public page, controller, and revision ID match the trusted record.
6. Reconnect OpenRouter, Telegram, and any other runtime credentials. They cannot be recovered from the portable file.
7. Send one test message only after the runtime credentials are restored.

An import fails when the connected wallet is not the controller, the schema is invalid, the hash cannot be reproduced, the avatar already exists, or the slug collides with another project.

## Restore after a complete provider loss

Operators should use the normal protected GitHub workflow, not a developer machine:

1. Create a new empty D1 database and private R2 bucket in the replacement Cloudflare account.
2. Update the protected deployment environment with the new resource IDs and wrapping key.
3. Deploy the Worker and apply every migration through `0006_portable_public_avatars.sql`.
4. Confirm `/health`, `/api/hosting/status`, and the anonymous `/api/public/avatars` route.
5. Have each owner sign in with the controlling wallet and import the trusted artifact.
6. Verify that the restored revision ID is identical to the pre-incident value.
7. Restore credentials from the separate secret manager and test integrations.

The environment account ID, D1 row IDs, and runtime thread IDs may change. The avatar ID, controller, bundle contents, SHA-256 digest, and revision ID must not.

## Automated drill

Run the focused recovery proof with the repository-required Node version:

```bash
bun test packages/cloudflare/src/portable-avatars.test.ts
```

The test named **restores an exported artifact into an empty environment with the same revision id** must pass. The same file also verifies public discovery, private isolation, portable download, NFT metadata, and sitemap behavior.

## Incident notes

- Do not treat a cached catalog row as a backup.
- Do not export encrypted credential rows into the avatar artifact.
- Do not change the bundle to make an import succeed; that creates a different revision.
- If only D1 is lost but R2 survives, recover the canonical R2 object and import it through the same path.
- If only R2 is lost but D1 survives, the D1 revision mirror can reproduce the artifact, but create a new external copy immediately.
