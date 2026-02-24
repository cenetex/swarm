# Energy System Engineering Plan

## Executive Summary

The energy system is a rate-limiting mechanism for expensive avatar operations (voice, image, video generation). This document describes the current architecture and proposes improvements for better user experience, observability, and extensibility.

---

## 1. Current System Architecture

### 1.1 Overview

The energy system uses a **token bucket algorithm** with hourly refill, implemented in [packages/admin-api/src/services/credits.ts](packages/admin-api/src/services/credits.ts). It operates alongside (but separate from) per-tool credit limits.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Avatar Energy System                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌──────────────────┐    ┌───────────────┐   │
│  │   Media     │───▶│  canUseEnergy()  │───▶│  DynamoDB     │   │
│  │   Service   │    │  consumeEnergy() │    │  CREDIT#energy│   │
│  └─────────────┘    └──────────────────┘    └───────────────┘   │
│                                                                  │
│  ┌─────────────┐    ┌──────────────────┐                        │
│  │   Voice     │───▶│  canUseEnergy()  │                        │
│  │   Service   │    │  consumeEnergy() │                        │
│  └─────────────┘    └──────────────────┘                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Configuration Constants

```typescript
// packages/admin-api/src/services/credits.ts
export const ENERGY_MAX = 10;        // Maximum energy pool
export const ENERGY_PER_HOUR = 1;    // Refill rate

export const ENERGY_COSTS = {
  voice: 1,   // Voice messages
  image: 2,   // Image generation  
  video: 3,   // Video generation
} as const;
```

### 1.3 Storage Schema

Energy buckets are stored in DynamoDB's `ADMIN_TABLE` using the `CreditBucket` interface:

```typescript
// packages/admin-api/src/types.ts
export interface CreditBucket {
  pk: string;              // AVATAR#{avatarId}
  sk: string;              // CREDIT#energy
  avatarId: string;
  toolName: string;        // 'energy'
  credits: number;         // Current energy (before refill calculation)
  maxCredits: number;      // 10
  lastRefillAt: number;    // Timestamp for refill calculation
  dailyUsed: number;       // Not used for energy
  dailyLimit: number;      // 999999 (no daily limit)
  dailyResetAt: number;    // Unused
}
```

### 1.4 Core Functions

| Function | Purpose |
|----------|---------|
| `getOrCreateEnergyBucket()` | Creates/retrieves energy bucket for an avatar |
| `calculateEnergyRefill()` | Computes current energy based on elapsed time |
| `canUseEnergy(avatarId, cost)` | Checks if avatar has enough energy |
| `consumeEnergy(avatarId, cost)` | Deducts energy after successful operation |
| `getEnergyStatus(avatarId)` | Returns current/max/nextRefillIn |

### 1.5 Usage Points

| Service | File | Operation | Cost |
|---------|------|-----------|------|
| Media | [media.ts#L383](packages/admin-api/src/services/media.ts#L383) | Image generation | 2 |
| Media | [media.ts#L857](packages/admin-api/src/services/media.ts#L857) | Video generation | 3 |
| Media | [media.ts#L950](packages/admin-api/src/services/media.ts#L950) | Sticker creation | 2 |
| Voice | [voice.ts#L667](packages/admin-api/src/services/voice.ts#L667) | Voice message | 1 |
| Voice | [voice.ts#L903](packages/admin-api/src/services/voice.ts#L903) | Voice note | 1 |

### 1.6 API Exposure

- **MCP Tool**: `get_energy_status` in [jobs.ts](packages/mcp-server/src/tools/jobs.ts#L147) - allows avatars to check their energy
- **Observability**: Energy included in system diagnostics via [observability.ts](packages/admin-api/src/services/observability.ts#L154)
- **Admin UI**: ⚠️ **No UI exposure currently**

---

## 2. Two-System Architecture: Energy vs Credits

The codebase has **two parallel rate-limiting systems**:

### 2.1 Energy System (Hourly Refill)
- **Scope**: Avatar-wide pool
- **Refill**: +1/hour, max 10
- **Purpose**: Rate-limit expensive compute operations
- **Costs**: voice=1, image=2, video=3

### 2.2 Tool Credit System (Per-Tool Buckets)
- **Scope**: Per-tool buckets per avatar
- **Refill**: Per-tool rate (e.g., 60/hour for images, 3600/hour for messages)
- **Purpose**: Prevent abuse of specific tools
- **Daily Limits**: Per-tool caps reset at UTC midnight

### 2.3 Configuration Example
```typescript
export const TOOL_CREDITS = {
  send_message: {
    creditsPerHour: 3600,   // 1/second
    maxCredits: 1,          // No burst
    dailyLimit: 86400,      // All day
  },
  generate_image: {
    creditsPerHour: 60,     // 1/minute
    maxCredits: 1,          // No burst
    dailyLimit: 1440,       // 24 hours worth
  },
  post_tweet: {
    creditsPerHour: 3,      // 1 every 20 min
    maxCredits: 10,         // Burst of 10
    dailyLimit: 50,         // 50 tweets/day
  },
};
```

### 2.4 How They Interact

Currently, **both systems are checked independently**:

```typescript
// In media.ts for image generation:
1. canUseTool(avatarId, 'generate_image')  // Tool credit check
2. canUseEnergy(avatarId, ENERGY_COSTS.image)  // Energy check
3. ... perform operation ...
4. consumeCredit(avatarId, 'generate_image')
5. consumeEnergy(avatarId, ENERGY_COSTS.image)
```

---

## 3. Pain Points & Issues

### 3.1 No User Visibility
- Avatars can check energy via `get_energy_status` MCP tool
- **No admin UI** shows energy status for avatars
- Operators cannot monitor or manage energy levels

### 3.2 Hardcoded Configuration
- `ENERGY_MAX`, `ENERGY_PER_HOUR`, `ENERGY_COSTS` are compile-time constants
- Cannot adjust per-avatar or per-tier without code changes
- No config.yaml support for energy settings

### 3.3 No Energy History/Analytics
- Cannot track energy usage patterns
- No metrics for capacity planning
- Cannot identify which avatars consume the most

### 3.4 Two-Check Overhead
- Every expensive operation requires 2 DynamoDB reads (energy + tool credit)
- Adds latency to hot paths
- Potential race conditions between check and consume

### 3.5 Inflexible Cost Model
- Fixed costs don't account for prompt complexity
- Video length/quality doesn't affect energy cost
- High-quality image models use same energy as fast ones

### 3.6 No Energy Gifting/Transfer
- Cannot give energy to avatars (e.g., for testing or premium features)
- No concept of energy packs or refill purchases

### 3.7 Error Messages Non-Actionable
```typescript
reason: `Not enough energy (have ${currentEnergy}, need ${cost}). +1 energy per hour. ~${hoursUntilEnough}h until enough.`
```
- No guidance on what to do (wait, reduce quality, etc.)
- No alternative suggestions

---

## 4. Proposed Improvements

### Phase 1: Observability & Admin Control (1-2 days)

#### 4.1.1 Admin UI Energy Panel
Add an energy status widget to the avatar detail view:

```tsx
// packages/admin-ui/src/components/AvatarEnergyPanel.tsx
interface EnergyStatus {
  current: number;
  max: number;
  nextRefillIn: number;
}

function AvatarEnergyPanel({ avatarId }: { avatarId: string }) {
  const { data } = useAvatarEnergy(avatarId);
  return (
    <Card>
      <CardHeader>Energy ⚡</CardHeader>
      <Progress value={data.current} max={data.max} />
      <Text>{data.current}/{data.max}</Text>
      {data.nextRefillIn > 0 && (
        <Text>Next refill in {data.nextRefillIn}m</Text>
      )}
    </Card>
  );
}
```

#### 4.1.2 Admin API Energy Endpoint
```typescript
// GET /api/avatars/{avatarId}/energy
{
  current: 7,
  max: 10,
  nextRefillIn: 23,  // minutes
  costs: { voice: 1, image: 2, video: 3 },
  recentUsage: [
    { timestamp: '...', operation: 'image', cost: 2 },
    { timestamp: '...', operation: 'voice', cost: 1 },
  ]
}
```

#### 4.1.3 Energy Admin Actions
```typescript
// POST /api/avatars/{avatarId}/energy/set
{ value: 10 }  // Admin can reset/boost energy

// POST /api/avatars/{avatarId}/energy/add
{ amount: 5 }  // Add energy (for premium/testing)
```

### Phase 2: Configuration & Flexibility (2-3 days)

#### 4.2.1 Avatar Config.yaml Energy Override
```yaml
# avatars/my-avatar/config.yaml
energy:
  max: 15                    # Override default 10
  refillPerHour: 2           # Override default 1
  costs:
    voice: 0                 # Free voice for this avatar
    image: 1                 # Cheaper images
    video: 2                 # Cheaper videos
```

#### 4.2.2 Tier-Based Energy System
```typescript
// New: packages/admin-api/src/services/energy-tiers.ts
const ENERGY_TIERS = {
  free: { max: 10, refillPerHour: 1 },
  pro: { max: 25, refillPerHour: 2 },
  enterprise: { max: 100, refillPerHour: 5 },
};

function getAvatarEnergyConfig(avatar: Avatar): EnergyConfig {
  // Check config.yaml override first
  if (avatar.config?.energy) {
    return avatar.config.energy;
  }
  // Fall back to tier
  return ENERGY_TIERS[avatar.tier || 'free'];
}
```

#### 4.2.3 Dynamic Cost Calculation
```typescript
// Energy cost based on operation parameters
function calculateImageEnergyCost(params: ImageParams): number {
  let cost = ENERGY_COSTS.image; // Base: 2
  
  if (params.quality === 'hd') cost += 1;
  if (params.model === 'dall-e-3') cost += 1;
  if (params.size === '1792x1024') cost += 1;
  
  return cost;
}
```

### Phase 3: Analytics & Metrics (2 days)

#### 4.3.1 Energy Usage Events
```typescript
// Log energy events to CloudWatch/DynamoDB
interface EnergyEvent {
  avatarId: string;
  operation: 'voice' | 'image' | 'video';
  cost: number;
  energyBefore: number;
  energyAfter: number;
  timestamp: number;
  requestId: string;
  metadata: Record<string, unknown>;
}

async function consumeEnergyWithLog(
  avatarId: string,
  cost: number,
  operation: EnergyOperation,
  metadata: Record<string, unknown>
): Promise<boolean> {
  const before = await getEnergyStatus(avatarId);
  const success = await consumeEnergy(avatarId, cost);
  
  if (success) {
    await logEnergyEvent({
      avatarId,
      operation,
      cost,
      energyBefore: before.current,
      energyAfter: before.current - cost,
      timestamp: Date.now(),
      requestId: context.requestId,
      metadata,
    });
  }
  
  return success;
}
```

#### 4.3.2 Energy Dashboard Metrics
```sql
-- CloudWatch Insights query for energy usage
fields @timestamp, avatarId, operation, cost
| filter eventType = 'energy_consumed'
| stats sum(cost) as totalEnergy, count() as operations by avatarId, operation
| sort totalEnergy desc
| limit 20
```

#### 4.3.3 Admin Dashboard Widget
```tsx
// Energy usage over time chart
function EnergyUsageChart({ avatarId }: Props) {
  const { data } = useEnergyHistory(avatarId, '7d');
  return (
    <AreaChart data={data}>
      <XAxis dataKey="hour" />
      <YAxis />
      <Area dataKey="voice" stackId="1" fill="#8884d8" />
      <Area dataKey="image" stackId="1" fill="#82ca9d" />
      <Area dataKey="video" stackId="1" fill="#ffc658" />
    </AreaChart>
  );
}
```

### Phase 4: Optimization & UX (2 days)

#### 4.4.1 Atomic Check-and-Consume
Replace two-step check+consume with atomic operation:

```typescript
// New: tryConsumeEnergy returns result with context
interface ConsumeResult {
  success: boolean;
  energyBefore: number;
  energyAfter: number;
  error?: {
    code: 'INSUFFICIENT_ENERGY';
    current: number;
    required: number;
    waitTime: number;  // minutes
    alternatives: string[];
  };
}

async function tryConsumeEnergy(
  avatarId: string,
  cost: number
): Promise<ConsumeResult> {
  const bucket = await getOrCreateEnergyBucket(avatarId);
  const current = calculateEnergyRefill(bucket);
  
  if (current < cost) {
    return {
      success: false,
      energyBefore: current,
      energyAfter: current,
      error: {
        code: 'INSUFFICIENT_ENERGY',
        current,
        required: cost,
        waitTime: Math.ceil((cost - current) * 60),
        alternatives: getSuggestedAlternatives(cost),
      },
    };
  }
  
  // Atomic update with condition
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: bucket.pk, sk: bucket.sk },
    UpdateExpression: 'SET credits = credits - :cost, lastRefillAt = :now',
    ConditionExpression: 'credits >= :cost',
    ExpressionAttributeValues: {
      ':cost': cost,
      ':now': Date.now(),
    },
  }));
  
  return {
    success: true,
    energyBefore: current,
    energyAfter: current - cost,
  };
}
```

#### 4.4.2 Helpful Error Messages
```typescript
function getSuggestedAlternatives(requiredCost: number): string[] {
  const alternatives = [];
  
  if (requiredCost === ENERGY_COSTS.video) {
    alternatives.push('Try generating an image instead (costs 2⚡ vs 3⚡)');
  }
  if (requiredCost >= ENERGY_COSTS.image) {
    alternatives.push('Use a faster/cheaper image model');
  }
  alternatives.push(`Wait ${Math.ceil(requiredCost / ENERGY_PER_HOUR)} hours for full recharge`);
  
  return alternatives;
}
```

#### 4.4.3 Energy Preview in Tool Responses
```typescript
// Include energy status in media generation responses
return {
  success: true,
  data: { imageUrl: result.url },
  energyStatus: {
    before: 7,
    after: 5,
    nextRefillIn: 23,
  },
  hint: 'You have 5⚡ remaining. Next image in 46 minutes.',
};
```

### Phase 5: Future Enhancements (Backlog)

#### 4.5.1 Energy Packs (Monetization)
```typescript
// Purchase energy with tokens
interface EnergyPack {
  id: string;
  energy: number;
  priceTokens: number;
}

const ENERGY_PACKS: EnergyPack[] = [
  { id: 'small', energy: 5, priceTokens: 100 },
  { id: 'medium', energy: 15, priceTokens: 250 },
  { id: 'large', energy: 50, priceTokens: 750 },
];
```

#### 4.5.2 Energy Sharing/Gifting
```typescript
// Transfer energy between avatars
async function transferEnergy(
  fromAvatarId: string,
  toAvatarId: string,
  amount: number
): Promise<boolean>;
```

#### 4.5.3 Scheduled Energy Boost
```typescript
// Temporary energy boost during events
interface EnergyBoost {
  avatarId: string;
  multiplier: number;  // 2x refill rate
  expiresAt: number;
}
```

#### 4.5.4 Energy Notifications
```typescript
// Notify when energy is restored
await sendNotification(avatarId, {
  type: 'energy_restored',
  message: 'Your energy is fully restored! ⚡10/10',
});
```

---

## 5. Implementation Priority

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | Admin UI energy panel | 0.5d | High - visibility |
| P0 | Admin API energy endpoint | 0.5d | High - API access |
| P1 | Avatar config.yaml energy override | 1d | Med - flexibility |
| P1 | Atomic check-and-consume | 0.5d | Med - reliability |
| P1 | Energy usage logging | 0.5d | Med - analytics |
| P2 | Tier-based energy | 1d | Med - monetization |
| P2 | Helpful error messages | 0.5d | Med - UX |
| P2 | Energy preview in responses | 0.5d | Med - UX |
| P3 | Energy packs | 2d | Low - future |
| P3 | Energy sharing | 1d | Low - future |

---

## 6. Migration Plan

### 6.1 Backward Compatibility
All changes maintain backward compatibility:
- Default constants remain unchanged
- Existing energy buckets continue to work
- No migration required for existing data

### 6.2 Feature Flags
```typescript
const ENERGY_FEATURES = {
  configOverride: process.env.ENERGY_CONFIG_OVERRIDE === 'true',
  tierSystem: process.env.ENERGY_TIER_SYSTEM === 'true',
  usageLogging: process.env.ENERGY_USAGE_LOGGING === 'true',
};
```

### 6.3 Rollout Stages
1. **Stage 1**: Deploy observability (UI, API, logging) to staging
2. **Stage 2**: Enable config override for select avatars
3. **Stage 3**: Roll out tier system with feature flag
4. **Stage 4**: Full production rollout

---

## 7. Testing Strategy

### 7.1 Unit Tests
```typescript
// packages/admin-api/src/services/credits.test.ts
describe('Energy System', () => {
  it('should refill energy correctly', async () => {
    // Set bucket with 5 energy, lastRefillAt = 2 hours ago
    const status = await getEnergyStatus(testAvatarId);
    expect(status.current).toBe(7); // 5 + 2 hours
  });

  it('should cap energy at max', async () => {
    // Set bucket with 9 energy, lastRefillAt = 5 hours ago
    const status = await getEnergyStatus(testAvatarId);
    expect(status.current).toBe(10); // Capped at max
  });

  it('should reject when insufficient energy', async () => {
    const result = await canUseEnergy(testAvatarId, 5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Not enough energy');
  });
});
```

### 7.2 Integration Tests
```typescript
describe('Energy Integration', () => {
  it('should consume energy on image generation', async () => {
    const before = await getEnergyStatus(testAvatarId);
    await generateImage({ avatarId: testAvatarId, prompt: 'test' });
    const after = await getEnergyStatus(testAvatarId);
    expect(after.current).toBe(before.current - ENERGY_COSTS.image);
  });
});
```

---

## 8. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Admin visibility | 100% avatars visible | UI usage tracking |
| Config adoption | 20% avatars with custom config | Config scan |
| Error reduction | 50% fewer "out of energy" complaints | Support tickets |
| Usage insights | 7d energy history available | Dashboard access |

---

## Appendix A: File References

| File | Purpose |
|------|---------|
| [credits.ts](packages/admin-api/src/services/credits.ts) | Energy system implementation |
| [types.ts#L634](packages/admin-api/src/types.ts#L634) | CreditBucket interface |
| [media.ts](packages/admin-api/src/services/media.ts) | Image/video energy consumption |
| [voice.ts](packages/admin-api/src/services/voice.ts) | Voice energy consumption |
| [jobs.ts](packages/mcp-server/src/tools/jobs.ts) | MCP get_energy_status tool |
| [observability.ts](packages/admin-api/src/services/observability.ts) | Energy in diagnostics |

---

*Document created: 2026-01-20*
*Author: Engineering Team*
*Status: Draft - Pending Review*
