# @swarm/profile-page

Public avatar profile pages served at `rati.chat`.

## Purpose

This is a lightweight, single-page application that renders a public profile for any avatar in the swarm. It displays:

- Avatar name, image, and tier badge
- Burn stats (total burned, rank, progress to next tier)
- Energy level and regeneration rate
- Token info (symbol, links to Solscan) if the avatar has launched a token
- Social links (Twitter, Telegram)
- Wallet address
- Burn history with on-chain transaction links

## How Routing Works

The page resolves the avatar ID from the URL using three strategies (checked in order):

1. **Subdomain** -- `avatar-id.rati.chat`
2. **Path** -- `rati.chat/avatar-id`
3. **Query param** -- `localhost?avatar=avatar-id` (local development)

It then fetches the profile from the API (`https://api.rati.chat/api/profile/{avatarId}`) and renders it client-side.

## Tech Stack

- Vanilla HTML/CSS/JS (no framework)
- Vite for dev server and production build
- Deployed to S3 + CloudFront

## Scripts

```bash
pnpm dev               # Vite dev server
pnpm build             # Production build to dist/
pnpm preview           # Preview production build locally
pnpm deploy:staging    # Build and sync to staging S3 bucket
pnpm deploy:prod       # Build and sync to production S3 bucket
pnpm invalidate:staging  # Invalidate staging CloudFront cache
pnpm invalidate:prod     # Invalidate production CloudFront cache
```

## Directory Layout

```
index.html     # Single-page app (HTML + inline CSS + JS)
package.json
```
