# Unit Economics Validation Framework

> **Status**: DRAFT -- requires real data from Design Partner Beta
> **Date**: 2026-03-01
> **Owner**: Leadership
> **Governing Issue**: #650
> **Governing Authority**: [PROJECT-CHARTER.md](./PROJECT-CHARTER.md) Section 4 (Unit Economics)
> **Review Cadence**: Monthly during Design Partner Beta (per Charter Section 6 Reporting Cadence)
> **Board Requirement**: Validated unit economics before scaling beyond 50 paying users

---

## 1. Purpose

At current OpenRouter pricing and full entitlement usage, per-user variable costs may exceed subscription revenue for both Pro and Enterprise tiers. This document establishes the measurement framework, targets, and decision thresholds for validating unit economics during the Design Partner Beta.

The Board requires a validated unit-economics model before scaling beyond 50 paying users (PROJECT-CHARTER.md Section 4). This document is the deliverable for that requirement.

---

## 2. Cost Model

### 2a. Variable Costs (Per Message)

The dominant variable cost is the LLM API call via OpenRouter. Infrastructure costs (Lambda, DynamoDB, SQS) are secondary.

| Cost Component | Estimated Cost | Source | Notes |
|----------------|---------------|--------|-------|
| LLM API (OpenRouter) | $0.03-0.05/message | PROJECT-CHARTER.md Section 4 | Varies by model; includes input + output tokens |
| Lambda compute | ~$0.001/message | AWS Lambda pricing | 256MB, ~2s avg duration |
| DynamoDB read/write | ~$0.0005/message | AWS DynamoDB pricing | 1-2 WCU + 1-2 RCU per message |
| SQS | ~$0.0001/message | AWS SQS pricing | 1-2 requests per message |
| **Total variable cost** | **~$0.03-0.05/message** | | LLM API dominates (~95%+ of variable cost) |

**Key insight**: LLM API costs are 95%+ of variable cost. Infrastructure costs are negligible at current scale. Cost optimization efforts must focus on LLM spend.

### 2b. Fixed Costs (Infrastructure Idle)

| Component | Monthly Cost | Source |
|-----------|-------------|--------|
| Production idle (target) | $240/mo ($8/day) | STRATEGY-OPERATIONS.md Section 4 |
| Staging idle (target) | $75/mo ($2.50/day) | STRATEGY-OPERATIONS.md Section 4 |
| **Total fixed infrastructure** | **~$315/mo** | |

### 2c. Cost Per Active Avatar Per Day

| Metric | Target | Source |
|--------|--------|--------|
| Cost per active avatar/day | <= $1.50 | STRATEGY-OPERATIONS.md Section 4 |
| Cost per message | <= $0.05 | STRATEGY-OPERATIONS.md Section 4 |

---

## 3. Revenue Per Tier

### 3a. Subscription Revenue

| Tier | Monthly Price | Source |
|------|-------------|--------|
| Free | $0 | BILLING-STRATEGY.md |
| Pro | $9/mo | BILLING-STRATEGY.md, PROJECT-CHARTER.md |
| Enterprise | $29/mo | BILLING-STRATEGY.md, PROJECT-CHARTER.md |

### 3b. Additional Revenue Streams

| Stream | Estimated Revenue | Status |
|--------|------------------|--------|
| Metered overage (media, voice, video) | $0.05-0.25/unit | Defined in Stripe product config; not yet active |
| NFT sales (Gate NFT mint + royalties) | Variable | Active (web3 layer) |
| RATI token burns (burn-to-energy) | Variable | Active (web3 layer) |

### 3c. Break-Even Analysis (Fixed Costs Only)

From PROJECT-CHARTER.md Section 4:

| Scenario | Subscribers Needed | Derivation |
|----------|--------------------|-----------|
| Pro only ($9/mo) | **27 subscribers** | $240 / $9 |
| Enterprise only ($29/mo) | **9 subscribers** | $240 / $29 |
| Mixed (15 Pro + 3 Enterprise) | **18 subscribers** ($222/mo) | 15 x $9 + 3 x $29 |

These figures cover **fixed infrastructure costs only** and do not account for variable (per-message) costs.

---

## 4. Per-User Economics at Entitlement Limits

This is the core problem identified in the Charter. At maximum entitlement usage, variable costs exceed subscription revenue.

### 4a. Pro Tier ($9/mo)

| Metric | Value | Derivation |
|--------|-------|-----------|
| Daily message limit | 50 messages/day | BILLING-STRATEGY.md |
| Monthly messages (max) | 1,500 | 50 x 30 days |
| Variable cost at $0.03/msg | $45/mo | 1,500 x $0.03 |
| Variable cost at $0.05/msg | $75/mo | 1,500 x $0.05 |
| Subscription revenue | $9/mo | |
| **Gross margin at max usage** | **-$36 to -$66/mo** | **Deeply negative** |

### 4b. Enterprise Tier ($29/mo)

| Metric | Value | Derivation |
|--------|-------|-----------|
| Daily message limit | Unlimited (est. ~200/day typical) | BILLING-STRATEGY.md |
| Monthly messages (est.) | 6,000 | 200 x 30 days |
| Variable cost at $0.03/msg | $180/mo | 6,000 x $0.03 |
| Variable cost at $0.05/msg | $300/mo | 6,000 x $0.05 |
| Subscription revenue | $29/mo | |
| **Gross margin at max usage** | **-$151 to -$271/mo** | **Deeply negative** |

### 4c. Break-Even Messages Per Day (by cost per message)

For each tier, the maximum messages per day to maintain a target gross margin:

| Tier | Revenue | Target Margin | Max Monthly Cost | Max Messages/Mo @ $0.03 | Max Messages/Mo @ $0.05 | Max Messages/Day |
|------|---------|--------------|-----------------|------------------------|------------------------|-----------------|
| Pro ($9) | $9 | 50% | $4.50 | 150 | 90 | **3-5 msg/day** |
| Pro ($9) | $9 | 0% (break-even) | $9.00 | 300 | 180 | **6-10 msg/day** |
| Enterprise ($29) | $29 | 50% | $14.50 | 483 | 290 | **10-16 msg/day** |
| Enterprise ($29) | $29 | 0% (break-even) | $29.00 | 967 | 580 | **19-32 msg/day** |

**Key insight**: At current pricing, Pro users must average fewer than 5-10 messages/day to be profitable. Enterprise users must average fewer than 16-32 messages/day. Both tiers offer limits far exceeding these thresholds (50/day and unlimited respectively).

---

## 5. Gross Margin Targets

From PROJECT-CHARTER.md Section 4:

> **Gross margin target: 50%+ per subscriber at typical (not maximum) usage.**

### 5a. Required Usage Patterns for 50% Margin

| Tier | Max Affordable Cost | Max Messages/Day @ $0.03 | Max Messages/Day @ $0.05 |
|------|--------------------|--------------------------|--------------------------|
| Pro ($9) | $4.50/mo | 5 msg/day | 3 msg/day |
| Enterprise ($29) | $14.50/mo | 16 msg/day | 10 msg/day |

Profitability depends entirely on users consuming **well below** their daily entitlement limits.

---

## 6. Metrics to Track During Beta

### 6a. Primary Metrics (Report Monthly to Board)

| Metric | Description | Data Source | Target |
|--------|-------------|-------------|--------|
| Average messages/user/day | Actual daily usage vs. entitlement limit | DynamoDB usage records | < 10 msg/day (Pro), < 20 msg/day (Enterprise) |
| Average cost/message (by model) | Actual LLM + infra cost per message | OpenRouter billing API + AWS Cost Explorer | <= $0.05 |
| Revenue per user per month (ARPU) | Subscription + overage revenue | Stripe Dashboard | $9+ (Pro), $29+ (Enterprise) |
| Gross margin per user | (Revenue - Variable Cost) / Revenue | Derived | >= 50% |
| Infrastructure idle cost | Monthly fixed cost on zero-traffic days | AWS Cost Explorer | <= $240/mo (production) |

### 6b. Secondary Metrics

| Metric | Description | Data Source |
|--------|-------------|-------------|
| Limit utilization % | % of daily limit consumed (per user, per tier) | DynamoDB entitlement-enforcement records |
| Cost per message by model | Breakdown by OpenRouter model used | OpenRouter usage API |
| Media/voice cost per unit | Separate tracking for expensive operations | AWS Cost Explorer + OpenRouter |
| Peak vs. off-peak usage | Time-of-day distribution | CloudWatch metrics |
| Token count per message (input + output) | LLM cost driver | OpenRouter usage data |
| Free-to-paid conversion rate | % of free users upgrading | Stripe + DynamoDB |
| Churn rate (monthly) | % of paying users canceling | Stripe Dashboard |

### 6c. Existing Monitoring Infrastructure

The following are already deployed and can feed unit economics tracking:

| System | What It Tracks | Reference |
|--------|---------------|-----------|
| Daily operations report | AWS cost, messages processed, active avatars, cost per message | OPERATIONS-REPORTS.md |
| Leadership Scorecard | 25 metrics including cost trends | LEADERSHIP-SCORECARD.md |
| CloudWatch Ops Dashboard | Lambda metrics, queue depths, DLQ counts | PROJECT-CHARTER.md SO-4 |
| Cost Controls Playbook | Day-over-day cost signals, variance bands | COST-CONTROLS-PLAYBOOK.md |
| Stripe Dashboard | MRR, subscriptions, churn, disputes | Stripe account |

---

## 7. Dashboard and Tracking Plan

### 7a. Data Collection Requirements

| Data Point | Collection Method | Frequency | Owner |
|------------|------------------|-----------|-------|
| OpenRouter spend by model | OpenRouter billing API or dashboard export | Daily | Platform Eng |
| AWS service costs | AWS Cost Explorer / daily operations report | Daily (automated) | Platform Eng |
| Messages processed per user | DynamoDB STATE_TABLE usage counters | Real-time (aggregate daily) | Platform Eng |
| Subscription revenue | Stripe Dashboard / Stripe API | Real-time | Leadership |
| Entitlement limit utilization | entitlement-enforcement.ts usage tracking | Real-time (aggregate daily) | Platform Eng |

### 7b. Reporting Deliverables

| Report | Frequency | Audience | Content |
|--------|-----------|----------|---------|
| Unit Economics Summary | Monthly | Board | ARPU, cost/message, gross margin by tier, usage patterns |
| Cost Per Message Trend | Weekly | Leadership | Model-level cost breakdown, trend vs. target |
| Usage Pattern Analysis | Monthly | Leadership | Limit utilization distribution, power user identification |
| Margin Alert | Ad-hoc | Leadership + Board | Triggered when blended gross margin falls below 50% |

---

## 8. Decision Thresholds

### 8a. When to Act

| Condition | Threshold | Required Action |
|-----------|-----------|-----------------|
| Blended gross margin < 50% | Sustained for 2 consecutive months | Propose mitigation plan to Board (Section 9) |
| Blended gross margin < 25% | Any single month | Emergency review: price increase, usage caps, or provider negotiation |
| Blended gross margin < 0% | Any single month | Halt new subscriber onboarding until economics are fixed |
| Average messages/day > break-even threshold | Per-tier, sustained 2 weeks | Implement per-tier usage interventions |
| Cost per message > $0.05 | Sustained 1 week | Model routing optimization or provider switch |
| Single user variable cost > 3x subscription price | Any billing cycle | Flag for usage review; consider metered overage enforcement |

### 8b. When to Raise Prices

Price increases should be considered when:

1. Actual average usage exceeds break-even messages/day for a tier (Section 4c)
2. Gross margin target (50%) cannot be met through cost optimization alone
3. Comparable platforms charge meaningfully more for similar capabilities
4. Design Partner feedback confirms willingness to pay more

Price changes require Board approval and 30-day notice to existing subscribers.

### 8c. When to Cap Usage

Usage caps (below entitlement limits) should be considered when:

1. A small number of power users drive disproportionate cost
2. Average usage is within target but P99 users cause margin collapse
3. Cost optimization (model routing, caching) has been exhausted

Implementation: reduce entitlement limits or enforce metered overage billing beyond a lower threshold.

### 8d. When to Negotiate Provider Rates

Provider rate negotiation should begin when:

1. Monthly OpenRouter spend exceeds $500 (volume leverage)
2. Commitment to a minimum monthly spend can be made
3. Alternative providers offer comparable quality at lower cost

---

## 9. Scenario Analysis

### Scenario A: Low Usage (Profitable)

**Assumption**: Users average 5 messages/day (10% of Pro limit).

| Metric | Pro ($9/mo) | Enterprise ($29/mo) |
|--------|-------------|---------------------|
| Messages/month | 150 | 150 |
| Variable cost @ $0.04/msg | $6.00 | $6.00 |
| Gross margin | **33%** | **79%** |
| Gross profit | $3.00 | $23.00 |

**Assessment**: Enterprise is healthy. Pro is marginal but positive. Blended margin depends on tier mix.

### Scenario B: Medium Usage (Marginal)

**Assumption**: Users average 15 messages/day (30% of Pro limit).

| Metric | Pro ($9/mo) | Enterprise ($29/mo) |
|--------|-------------|---------------------|
| Messages/month | 450 | 450 |
| Variable cost @ $0.04/msg | $18.00 | $18.00 |
| Gross margin | **-100%** | **38%** |
| Gross profit | -$9.00 | $11.00 |

**Assessment**: Pro is unprofitable. Enterprise is below 50% target. Intervention needed -- either price increase for Pro or cost reduction.

### Scenario C: High Usage (Unprofitable)

**Assumption**: Users average 40 messages/day (80% of Pro limit; moderate for Enterprise).

| Metric | Pro ($9/mo) | Enterprise ($29/mo) |
|--------|-------------|---------------------|
| Messages/month | 1,200 | 1,200 |
| Variable cost @ $0.04/msg | $48.00 | $48.00 |
| Gross margin | **-433%** | **-66%** |
| Gross profit | -$39.00 | -$19.00 |

**Assessment**: Both tiers deeply unprofitable. Immediate action required.

### Scenario D: Realistic Mixed (Target)

**Assumption**: 70% of users at Scenario A, 25% at Scenario B, 5% at Scenario C.

| Metric | Weighted Avg Pro | Weighted Avg Enterprise |
|--------|-----------------|------------------------|
| Weighted variable cost/user/mo | $9.30 | $9.30 |
| Gross margin | **-3%** | **68%** |

**Assessment**: Enterprise viable. Pro approximately break-even. Overall viability depends on tier mix skewing toward Enterprise. A 50/50 Pro/Enterprise mix yields ~32% blended margin -- below the 50% target.

---

## 10. Mitigation Strategies

### 10a. Model Routing (Highest Impact)

Route messages to cheaper models when full capability is not needed.

| Strategy | Estimated Savings | Complexity | Notes |
|----------|------------------|------------|-------|
| Use cheaper models for simple/short messages | 50-70% cost reduction | Medium | Classify message complexity; route accordingly |
| Use smaller context windows | 20-40% cost reduction | Low | Truncate conversation history for routine messages |
| Cache system prompts | 10-20% cost reduction | Low | Reduce input tokens for repeated avatar personalities |

**Impact example**: If model routing reduces average cost from $0.04 to $0.015/message, Pro break-even rises from 6-10 msg/day to 20-30 msg/day.

### 10b. Response Caching

| Strategy | Estimated Savings | Complexity | Notes |
|----------|------------------|------------|-------|
| Cache identical or near-identical queries | 5-15% of total LLM calls | Medium | Requires semantic similarity matching |
| Cache tool call results | 10-20% of tool-augmented messages | Low | Time-bounded cache for repeated tool use |

### 10c. Rate Limiting and Overage Billing

| Strategy | Revenue Impact | Complexity | Notes |
|----------|---------------|------------|-------|
| Lower Pro daily message limit (50 -> 20) | Reduces max variable cost by 60% | Low | May reduce perceived value |
| Enforce metered overage beyond base limit | Generates additional revenue from power users | Medium | Stripe metered billing already designed |
| Implement soft warnings at 80% of limit | Reduces average usage by ~10-15% | Low | Behavioral nudge |

### 10d. Provider Negotiation

| Strategy | Estimated Savings | Requirements |
|----------|------------------|-------------|
| Volume discount from OpenRouter | 10-30% | $500+/mo commitment |
| Direct API access (bypass OpenRouter) | 20-40% | Engineering effort to integrate directly with model providers |
| Negotiate committed-use pricing | 15-25% | Predictable monthly volume |

### 10e. Price Increases

| Change | Impact on Break-Even | Risk |
|--------|---------------------|------|
| Pro $9 -> $15/mo | Break-even rises to 10-17 msg/day | May reduce conversion |
| Pro $9 -> $19/mo | Break-even rises to 13-21 msg/day | Competitive risk |
| Enterprise $29 -> $49/mo | Break-even rises to 33-54 msg/day | Better alignment with unlimited usage |
| Add "Basic" tier at $5/mo with 10 msg/day limit | Low-cost entry point; profitable at < 3-6 msg/day | Segment pricing |

---

## 11. Validation Plan for Design Partner Beta

### 11a. Beta Parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| Maximum beta users | 10 | PROJECT-CHARTER.md Section 1b |
| Onboarding | Manual (no self-serve checkout) | PROJECT-CHARTER.md Section 1b |
| Cancellation policy | Full refund within 30 days | PROJECT-CHARTER.md Section 1b |
| Duration | Until public billing gate is met | PROJECT-CHARTER.md Section 1b |

### 11b. What We Need to Learn

1. **What is the actual average messages/user/day?** This is the single most important variable. If typical usage is < 10 msg/day, current pricing may work. If > 20 msg/day, pricing must change.

2. **What is the actual cost per message?** The $0.03-0.05 estimate needs validation with real OpenRouter billing data. Model mix, token counts, and tool usage all affect this.

3. **What % of the daily limit do users actually consume?** If most users consume < 20% of their limit, the economics may work despite the theoretical negative margin at full usage.

4. **Do users perceive $9/mo and $29/mo as fair value?** Design partner conversations should explicitly probe willingness to pay.

5. **Which models are most cost-effective without degrading quality?** Real usage data will reveal which model routing strategies are viable.

### 11c. Monthly Board Report Template

Each monthly report during beta should include:

```
UNIT ECONOMICS -- MONTHLY REPORT
Period: [Month Year]
Active Paying Users: [count by tier]

1. USAGE
   - Avg messages/user/day: [actual] (target: < 10 Pro, < 20 Enterprise)
   - Limit utilization: [%] of daily limit consumed on average
   - P90 messages/user/day: [actual]

2. COSTS
   - Avg cost/message: $[actual] (target: <= $0.05)
   - Total LLM spend: $[actual]
   - Total infra spend: $[actual]
   - Infrastructure idle cost: $[actual]/mo (target: <= $240)

3. REVENUE
   - MRR: $[actual]
   - ARPU: $[actual]
   - Overage revenue: $[actual]

4. MARGINS
   - Gross margin (Pro): [%] (target: >= 50%)
   - Gross margin (Enterprise): [%] (target: >= 50%)
   - Blended gross margin: [%] (target: >= 50%)

5. ACTIONS
   - [List any threshold breaches from Section 8a]
   - [List proposed mitigations if margin < 50%]

6. RECOMMENDATION
   - [ ] Continue at current pricing
   - [ ] Implement cost optimization (specify)
   - [ ] Adjust pricing (specify)
   - [ ] Halt scaling until economics improve
```

---

## 12. Open Questions

1. **What is the actual model mix?** Different OpenRouter models have vastly different per-token costs. The $0.03-0.05 estimate may be high or low depending on which models avatars use.

2. **Should Enterprise have a message cap?** "Unlimited" messages at $29/mo is structurally unprofitable if users send more than ~20 messages/day at current costs. Consider a high but finite limit (e.g., 500/day) or metered overage.

3. **Is OpenRouter the right provider long-term?** Direct API access to model providers could reduce costs 20-40%, but adds engineering complexity and reduces model flexibility.

4. **What is the overage pricing sweet spot?** Metered overage ($0.05-0.25/unit) could make power users profitable, but may deter adoption.

5. **Should model routing be tier-dependent?** Free and Pro users could default to cheaper models, with Enterprise users getting access to premium models. This directly improves per-tier margins.

---

## Appendix A: Data Sources and Formulas

### Cost Per Message
```
cost_per_message = (openrouter_daily_spend + lambda_daily_cost + dynamodb_daily_cost + sqs_daily_cost) / messages_processed
```

### Gross Margin Per User
```
gross_margin = (subscription_revenue - variable_cost) / subscription_revenue
variable_cost = messages_sent * cost_per_message
```

### Break-Even Messages Per Day
```
break_even_messages_per_day = subscription_price / (cost_per_message * 30)
```

### Limit Utilization
```
limit_utilization = actual_messages_per_day / entitlement_message_limit_per_day
```

---

*This document is a DRAFT. All estimates are based on OpenRouter pricing as of 2026-03-01 and entitlement limits defined in BILLING-STRATEGY.md. Actual values will be populated during Design Partner Beta and reported to the Board monthly per PROJECT-CHARTER.md Section 6.*
