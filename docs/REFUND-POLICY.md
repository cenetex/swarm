# Refund and Cancellation Policy

> **Status**: DRAFT -- Pending Legal Review
> **Date**: 2026-03-01
> **Version**: 0.1
> **Related**: [BILLING-STRATEGY.md](./BILLING-STRATEGY.md) | [DESIGN-PARTNER-PROGRAM.md](./DESIGN-PARTNER-PROGRAM.md)

---

## 1. Overview

This document describes the refund and cancellation policy for AWS Swarm platform subscriptions managed through Stripe. It applies to all paid subscription tiers: **Pro ($9/mo)** and **Enterprise ($29/mo)**.

The Free tier ($0) has no billing and is not subject to this policy. Users on any paid tier may downgrade to Free at any time.

---

## 2. Subscription Plans

| Plan | Price | Billing Cycle |
|------|-------|---------------|
| Free | $0 | No billing |
| Pro | $9/month | Monthly recurring |
| Enterprise | $29/month | Monthly recurring |
| Custom | Negotiated | Per agreement |

Custom enterprise agreements may include terms that supersede this policy. Those terms will be documented in the individual agreement.

---

## 3. Cancellation

### 3.1 How to Cancel

Subscribers can cancel their subscription at any time through the **Stripe Customer Portal**. The portal is accessible via the admin chat interface using the billing management command.

No email, phone call, or support ticket is required to cancel. Cancellation is entirely self-serve.

### 3.2 When Cancellation Takes Effect

Cancellation takes effect at the **end of the current billing period**. When a subscriber cancels:

1. The subscription remains active through the end of the already-paid billing period.
2. All plan features (message limits, media credits, voice minutes, memory, platform access) remain available until the period ends.
3. At the end of the billing period, the account is automatically downgraded to the **Free tier**.
4. No further charges are billed.

There is no immediate termination of service upon cancellation. Subscribers retain access to what they have already paid for.

### 3.3 What Happens After Downgrade

When a paid subscription ends and the account returns to Free tier:

- Daily message limit drops to 50 (from 500 Pro / unlimited Enterprise).
- Daily media credits drop to 5 (from 50 Pro / unlimited Enterprise).
- Daily voice minutes drop to 2 (from 30 Pro / unlimited Enterprise).
- Memory is disabled (Free tier does not include memory retention).
- Platform access is limited to 1 platform (from 3 Pro / unlimited Enterprise).
- Autonomous posting is disabled.
- Existing conversation history is retained but subject to Free tier data retention limits.

Web3 augmentations (Orb holder boosts, RATI energy, Avatar Ascension status) are unaffected by subscription cancellation and continue to apply independently.

### 3.4 Resubscribing

A user who cancels may resubscribe at any time through the Stripe Customer Portal or the admin chat interface. Entitlements are restored immediately upon successful payment.

---

## 4. Refund Policy

### 4.1 Design Partner Beta (Current Phase)

During the **Design Partner Beta** phase, the following refund terms apply:

- **Full refund available within 30 days of initial subscription purchase.**
- No questions asked. No justification required.
- Refunds are processed to the original payment method.
- After 30 days, standard refund terms (Section 4.2) apply.
- This policy applies to the first billing cycle only. Renewals after the first 30 days are subject to standard terms.

The Design Partner Beta phase ends when public billing is activated. Subscribers who joined during the beta retain their 30-day refund window for their initial subscription period only.

### 4.2 Standard Refund Policy (Post-Beta)

Once public billing is activated, the following standard refund terms apply:

- **Refunds are generally not provided** for partial billing periods. Cancellation takes effect at the end of the current period (Section 3.2).
- **Billing errors**: If a subscriber is charged incorrectly (duplicate charge, wrong amount, charge after cancellation), a full refund for the erroneous charge will be issued promptly.
- **Service outages**: If the platform experiences a sustained outage (defined as core chat functionality unavailable for more than 24 consecutive hours), affected subscribers may request a pro-rated credit for the outage period. Credits are applied to the next billing cycle.
- **Exceptional circumstances**: Refund requests outside the above categories may be submitted to the support contact (Section 6). These are reviewed on a case-by-case basis.

### 4.3 Pro-Rated Refunds

Pro-rated refunds are not issued for mid-cycle cancellations under standard terms. When a subscriber cancels, they retain access through the end of the billing period they have already paid for.

Pro-rated credits may be issued for:

- Verified platform outages exceeding 24 consecutive hours.
- Billing errors where the subscriber was overcharged.
- Plan downgrades from Enterprise to Pro mid-cycle (credit applied to next cycle).

### 4.4 Processing Timeline

- **Design Partner Beta refunds**: Processed within 5 business days of request.
- **Billing error refunds**: Processed within 5 business days of verification.
- **Service outage credits**: Applied to the next billing cycle after verification.
- **Exceptional circumstance refunds**: Reviewed within 10 business days; processing within 5 business days of approval.

Refunds are returned to the original payment method via Stripe. Depending on the payment provider and financial institution, the refund may take an additional 5-10 business days to appear on the subscriber's statement.

---

## 5. NFT and Token Considerations

The following are **not covered by this refund policy** and are non-refundable:

- **Orb (Gate NFT) purchases**: NFTs are purchased on-chain via the Solana blockchain. These are separate from platform subscriptions and are not managed through Stripe.
- **RATI token burns**: Tokens burned for energy or avatar ascension are consumed on-chain and cannot be reversed.
- **Lineage NFTs**: Minted as a result of avatar abandonment (Orb burn) and are non-refundable.
- **Avatar Ascension costs**: The combined Orb + RATI burn required for ascension is an on-chain action and is non-refundable.

Web3 assets and actions operate independently of the subscription billing system. Canceling a subscription does not affect on-chain holdings, and on-chain transactions are not eligible for refund through this policy.

---

## 6. How to Request a Refund

To request a refund:

1. **Email**: Send a refund request to **billing@swarm.ratimics.com** with the subject line "Refund Request" and include:
   - Your account identifier (Telegram username or wallet address)
   - The charge date and amount
   - The reason for the refund request

2. **Response SLA**: You will receive an acknowledgment within 2 business days and a resolution within the timeline specified in Section 4.4.

For billing questions that are not refund requests, use the same contact address.

---

## 7. Dispute Resolution

### 7.1 Internal Resolution

We encourage subscribers to contact us directly before initiating a payment dispute with their bank or card issuer. Most billing issues can be resolved faster through direct communication.

### 7.2 Chargeback Monitoring

The platform monitors chargeback rates through the Stripe dashboard. If the chargeback rate exceeds **1% of total transactions**, Leadership will initiate a review of:

- Billing clarity (are charges clearly described on statements?)
- Cancellation accessibility (is the cancellation flow easy to find and use?)
- Refund responsiveness (are legitimate refund requests being handled within SLA?)
- Pricing alignment (does pricing match perceived value?)

A chargeback rate above 1% is treated as a billing operations incident and triggers corrective action.

### 7.3 Fraudulent Charges

If a subscriber believes their payment method was used without authorization, they should:

1. Contact their bank or card issuer immediately to report the unauthorized charge.
2. Contact us at **billing@swarm.ratimics.com** so we can investigate and disable the affected account.

---

## 8. Free Tier

The Free tier has no billing. Free tier users:

- Are never charged.
- Can use the platform indefinitely at Free tier limits.
- Can upgrade to a paid tier at any time.
- Can downgrade from a paid tier back to Free at any time (Section 3).

There is no "trial period" that converts to a paid subscription. Free is a permanent tier, not a time-limited trial.

---

## 9. Changes to This Policy

This policy may be updated as the platform evolves. Changes will be:

- Committed to the repository at `docs/REFUND-POLICY.md`.
- Communicated to active subscribers via the billing contact email on file.
- Effective 30 days after notice, except for changes required by law, which take effect immediately.

Subscribers who do not agree with policy changes may cancel their subscription before the changes take effect and receive a pro-rated refund for the remaining billing period.

---

## 10. Policy Review Schedule

| Review Trigger | Action |
|----------------|--------|
| End of Design Partner Beta | Evaluate 30-day refund window usage; decide whether to extend, modify, or retire beta terms |
| Chargeback rate > 1% | Immediate review per Section 7.2 |
| Quarterly governance review | Policy reviewed as part of charter compliance (PROJECT-CHARTER.md Section 6) |
| Pricing or tier changes | Policy updated to reflect new plan structure |

---

> **DRAFT NOTICE**: This document is a draft pending legal review. It should not be published to customers or linked from the Stripe checkout flow until legal counsel has reviewed and approved the final version. Key areas requiring legal review: refund window duration, dispute resolution language, limitation of liability, and jurisdiction/governing law provisions.
