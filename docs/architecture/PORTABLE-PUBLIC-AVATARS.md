# Portable Public Avatars

Swarm avatars are public projects by default. The hosted runtime is one place where a project can run; it is not the avatar's identity and must not be the only copy.

## Source of truth

Each revision is a canonical JSON file using schema `swarm.avatar/v1`. Swarm sorts object keys, serializes the file, and hashes the exact bytes with SHA-256. The revision ID is `sha256:<hex digest>`.

The hash has three jobs:

- it gives the revision a stable, content-addressed identity;
- it lets an importer prove that a recovered file has not changed; and
- it gives an NFT or another ownership record a small stable value to reference.

D1 is the discovery and ownership index. R2 is the hosted mirror used for downloads. Neither database is the identity root. A downloaded or permanently anchored artifact can rebuild those runtime copies in an empty environment.

## What the artifact contains

The version 1 bundle contains:

- stable avatar ID, public slug, name, description, and controlling Solana wallet;
- public or private publication state and catalog listing state;
- public system prompt and conversation starters;
- declared capabilities;
- shared memory summary and public memory entries;
- media references and optional media hashes;
- parent avatar and previous revision lineage; and
- revision creation time.

The schema is strict. Unknown fields fail validation instead of silently entering an export.

## What it never contains

Portable artifacts do not contain:

- OpenRouter keys, Telegram bot tokens, webhook secrets, or other credentials;
- session cookies, wallet private keys, or encryption keys;
- private chat transcripts; or
- billing and tenant administration records.

Imported avatars must be controlled by the connected wallet named in the artifact. A stolen file alone does not grant control.

## Public, unlisted, and private

New avatars use `visibility: public` and `listed: true` unless the owner explicitly chooses otherwise.

Avatars created before the public-project migration remain private and unlisted. Their first portable artifact is created for the owner on access, but publication requires a later explicit owner action.

- **Public and listed** avatars appear in the registry and have anonymous project, bundle, revision, and NFT metadata routes.
- **Public and unlisted** avatars can be read by a direct link but do not appear in the registry.
- **Private** avatars are absent from anonymous routes. Their owner can still download and restore the artifact.

## Runtime storage

| Layer | Purpose | Can reconstruct the avatar? |
| --- | --- | --- |
| Canonical JSON artifact | Portable project revision | Yes |
| Permanent content URI, such as Arweave | Provider-independent public copy | Yes |
| NFT metadata | Ownership and pointer to one revision | Only through its bundle URI |
| R2 object | Fast hosted mirror | Yes, while the Swarm account exists |
| D1 rows | Catalog, ownership, current revision, and query index | No, unless the stored JSON mirror also survives |

An NFT should not contain the entire running avatar. It should establish ownership and point to the exact bundle URI, SHA-256 digest, schema, avatar ID, and revision ID. The public `nft-metadata` route returns that shape. Minting remains an owner-authorized wallet action; Swarm does not submit a chain transaction during ordinary avatar creation.

R2 and D1 are one operational fault domain. Disaster recovery is complete only after at least one artifact copy is downloaded or anchored outside the Swarm Cloudflare account. The Studio makes that artifact directly downloadable, and the recovery runbook treats the external copy as required.

## Public routes

| Route | Purpose |
| --- | --- |
| `GET /api/public/avatars` | Anonymous catalog of public, listed avatars |
| `GET /api/public/avatars/{slug}` | Anonymous public project and manifest |
| `GET /api/public/avatars/{slug}/bundle` | Current canonical artifact download |
| `GET /api/public/avatars/{slug}/nft-metadata` | NFT-ready ownership and artifact pointer |
| `GET /api/public/revisions/{revisionId}.json` | Immutable content-addressed revision |
| `GET /api/avatars/{avatarId}/bundle` | Owner download, including private avatars |
| `POST /api/avatars/import` | Wallet-authorized restore into an empty runtime |

## Revision rule

Every meaningful public change must create a new immutable bundle and revision ID. It must not overwrite an old revision. The hosted catalog may move its `current_revision_id` pointer, while NFTs and external archives can continue to reference an older revision exactly.

The first implementation creates and restores the genesis revision. Later persona, memory, capability, and media editors must use this same revision rule before they are allowed to mutate a portable avatar.

## Recovery proof

The automated restore test performs the core disaster exercise:

1. create a public avatar and export its bundle;
2. create a separate empty D1 and R2 environment;
3. import the bundle with the controlling wallet; and
4. verify that the rebuilt avatar has the same revision ID and is discoverable again.

See [`docs/PORTABLE-AVATAR-RECOVERY.md`](../PORTABLE-AVATAR-RECOVERY.md) for the operator and owner procedure.
