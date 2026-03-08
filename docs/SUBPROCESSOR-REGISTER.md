# Subprocessor Register

> Last updated: 2026-03-08
> Owner: Cenetex Inc. (Data Controller)
> Contact: privacy@cenetex.com
> Review cadence: Quarterly (next review due: 2026-06-08)

This register lists all third-party processors and subprocessors that process personal data on behalf of Cenetex Inc. in the operation of the RATi Avatar System (RATi OS). It is maintained as a living document and updated whenever a new processor is onboarded or an existing relationship changes.

## Processor Register

| # | Processor | Purpose | Data Categories Processed | Hosting Region | DPA Status | SCC Status | Processor Retention |
|---|-----------|---------|--------------------------|----------------|------------|------------|---------------------|
| 1 | **OpenRouter** (OpenRouter Inc.) | LLM inference routing (routes to Anthropic Claude, OpenAI GPT-4, and other models) | Conversation history, system prompts, avatar persona data | US (primarily) | Not yet executed | Not yet executed | Per OpenRouter's data policy; inputs are not used for training by default |
| 2 | **Replicate** (Replicate Inc.) | Image, video, and audio generation | AI model prompts, input media | US | Not yet executed | Not yet executed | Per Replicate's data policy; inputs deleted after processing |
| 3 | **Privy** (Privy Inc.) | Email/social authentication, identity management | Access tokens, email addresses, linked account data | US | Not yet executed | Not yet executed | Per Privy's data retention policy |
| 4 | **Helius** (Helius Labs Inc.) | Solana RPC, NFT ownership verification | Wallet public keys (Solana addresses) | US | N/A (public blockchain data only) | N/A | No personal data retained; queries are stateless |
| 5 | **AWS** (Amazon Web Services Inc.) | Infrastructure provider (DynamoDB, Lambda, S3, CloudWatch, Secrets Manager, SQS, CloudFront) | All backend data (see Privacy Policy Section 2 for full list) | US (us-east-1, us-west-2) | Covered by AWS DPA (GDPR Data Processing Addendum, automatically included in AWS service terms) | AWS participates in the EU-US Data Privacy Framework (DPF); SCCs available via AWS DPA | Per configured TTLs and lifecycle policies (see DATA-RETENTION-MATRIX.md) |
| 6 | **Telegram** (Telegram FZ-LLC) | Platform integration for avatar messaging | Message content, sender metadata, media | UAE / Global | N/A (platform API, not processor relationship) | N/A | Per Telegram's privacy policy |
| 7 | **Discord** (Discord Inc.) | Platform integration for avatar messaging | Message content, sender metadata, media | US | N/A (platform API, not processor relationship) | N/A | Per Discord's privacy policy |
| 8 | **X / Twitter** (X Corp.) | Platform integration for avatar posting | Message content, media | US | N/A (platform API, not processor relationship) | N/A | Per X's privacy policy |
| 9 | **Stripe** (Stripe Inc.) | Payment processing (billing, subscriptions) | Payment method data, email, billing address | US / Global | Covered by Stripe DPA (available at stripe.com/legal/dpa) | Stripe participates in the EU-US DPF; SCCs available via Stripe DPA | Per Stripe's data retention policy |
| 10 | **Solana RPC** (various public RPC providers) | On-chain queries, transaction submission | Wallet public keys (public blockchain data) | Global (decentralized) | N/A (public blockchain data only) | N/A | N/A (public ledger) |

## Notes on Processor Classification

- **Processors** (Art. 28 GDPR): OpenRouter, Replicate, Privy, AWS, and Stripe process personal data on our instructions. DPAs should be executed with each.
- **Platform APIs** (Telegram, Discord, X): These services act as independent controllers for data on their platforms. When users connect their avatars to these platforms, data is shared via platform APIs. These are not processor relationships under Art. 28 but are disclosed in the privacy policy under Art. 13/14.
- **Public blockchain services** (Helius, Solana RPC): These services interact with publicly available blockchain data (wallet addresses, NFT ownership). Wallet public keys are pseudonymous identifiers but may constitute personal data under GDPR. No personal data beyond public keys is shared.

## DPA Execution Status Summary

| Status | Processors |
|--------|-----------|
| Executed / covered by standard terms | AWS, Stripe |
| Not yet executed | OpenRouter, Replicate, Privy |
| N/A (not processor relationship) | Telegram, Discord, X, Helius, Solana RPC |

**Action required:** DPAs with OpenRouter, Replicate, and Privy should be executed before the next quarterly review. These are the highest-priority gaps identified in the GDPR Compliance Audit v2 (gap G1).

## Off-Repo Agreements

Executed legal artifacts (DPAs, SCCs, and related agreements) are maintained outside this repository by the legal and compliance team. This register documents the existence and status of these agreements; the binding legal documents themselves are not stored in source control.

| Artifact | Location | Responsible Party |
|----------|----------|-------------------|
| AWS DPA | Incorporated into AWS service terms; available at aws.amazon.com/compliance/gdpr-center | Legal team |
| Stripe DPA | Available at stripe.com/legal/dpa; executed as part of Stripe account setup | Legal team |
| OpenRouter DPA | Pending execution; contact privacy@cenetex.com for status | Legal team |
| Replicate DPA | Pending execution; contact privacy@cenetex.com for status | Legal team |
| Privy DPA | Pending execution; contact privacy@cenetex.com for status | Legal team |

**To request copies of executed agreements**, contact privacy@cenetex.com or the legal team directly.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-03-08 | Initial register created from privacy policy and infrastructure audit | Engineering |
