# RATiMICS Receipt Explorer

The explorer reads real evidence through `GET /api/receipts`. It does not put
source tokens in the browser and it does not fall back to samples. The marked
demo is available only with `?demo=1` or the **View demo** button.

## Source feeds

- **CosyWorld** accepts the protected `/moderation/events` response.
- **Swarm** accepts an avatar `/activity`, `/audit-log`, or `/logs?fast=true`
  response.
- **Signal** accepts the `signal.rati_mining_receipts.v1` JSON produced by
  `signal_rati_receipt` once that JSON is exposed through a protected HTTPS
  endpoint.
- **Raticross** accepts a protected list of envelopes, receipts, logs, or
  activity items. Current bridge logs are marked as recorded unless the source
  explicitly says a signature was verified.

Copy `.env.example` to `.env.local` for local use. In production, set the same
keys in Sites environment settings and mark every token as secret.

## Evidence labels

- **Verified** means the upstream source supplied a verifiable proof result.
- **Recorded** means the event exists in an operational or canonical journal,
  but is not cryptographically attested by the current feed.
- **Review** means the upstream source rejected the event or did not supply the
  proof needed for its claim.

The server caps each source at 100 records, rejects large responses, removes
secret-like fields, requires HTTPS in production, and reports failures per
source.
