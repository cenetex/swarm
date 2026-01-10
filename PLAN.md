# AWS Social Media Agent Swarm - Architecture Plan

---

## Implementation Status

> **Last Updated:** 2026-01-10

### Overall Progress

| Component | Status | Notes |
|-----------|--------|-------|
| Monorepo Setup | ✅ DONE | pnpm workspaces, TypeScript configs |
| Core Types | ✅ DONE | Comprehensive type definitions |
| Platform Adapters | ✅ DONE | Telegram, Twitter, Web complete. Discord missing. |
| Processors | ✅ DONE | Evaluator, Generator, OutboundSender complete |
| Services | ✅ DONE | State, Activity, LLM (with retry), Secrets, Media, Solana (NFT mint placeholder) |
| Handlers | ✅ DONE | Telegram webhook, message-processor, response-sender, web-chat, tweet-poster, mention poller |
| Infrastructure (CDK) | ✅ DONE | Shared/per-agent stacks plus admin API/UI constructs |
| **Lambda Layer** | ✅ DONE | `@swarm/layer` - AWS SDK, OpenAI deps |
| Agent Templates | 🟡 PARTIAL | Templates live in DB; no repo templates. Import/export component is pending. |
| Agent Configs | ⏳ NOT STARTED | No real agents configured yet |
| **Admin API** | ✅ DONE | `@swarm/admin-api` - Chat handler, services, auth |
| **Admin UI** | ✅ DONE | `@swarm/admin-ui` - React chat interface with multi-agent support |
| **Admin Infra** | ✅ DONE | CDK constructs with optional custom domains |
| **CI/CD** | ✅ DONE | GitHub Actions with layer bundling, CDK deploy, S3 sync |
| **Secrets Management** | ✅ DONE | Write-only secrets with KMS encryption |
| **Wallet Generation** | 🟡 PARTIAL | Solana implemented; Ethereum disabled pending ethers/viem |
| **Logs API** | 🟡 PARTIAL | `GET /agents/{id}/logs` exists; UI + standardized log schema pending. |
| **MCP Tool Registry + Server** | 🟡 PARTIAL | Registry package created; agent scoping + registration workflow pending. |
| **Billing + Entitlements** | ⏳ NOT STARTED | Paid plan gating and subscription lifecycle. |
| **Usage Metering** | ⏳ NOT STARTED | Per-agent usage tracking for billing and spend controls. |
| **Privacy + Retention Defaults** | ⏳ NOT STARTED | Stateless free tier and opt-in durable memory. |
| Tests | 🟡 PARTIAL | Vitest coverage in admin-api/core; no end-to-end tests |

### Admin Interface Features

| Feature | Status | Description |
|---------|--------|-------------|
| Cloudflare Access Auth | ✅ | JWT verification in handlers; policies managed in Cloudflare |
| Conversational Setup | ✅ | LLM-powered chat for agent configuration |
| Agent CRUD | ✅ | Create, list, update, delete agents |
| Platform Config | ✅ | Telegram/Twitter supported; Discord fields only |
| Secret Storage | ✅ | Write-only, KMS-encrypted, Secrets Manager |
| Global API Keys | ✅ | Shared keys with per-agent override |
| Wallet Generation | 🟡 | Solana only; Ethereum disabled |
| Deploy Trigger | ❌ | Not implemented (no deploy hook yet) |
| Logs UI | 🟡 | API exists; UI route not built yet |
| Import/Export Config | 🟡 | Templates stored in DB; add admin import/export workflow |
| **Multi-Agent UI** | ✅ | Discord-like sidebar with agent list |
| **Agent Avatars** | ✅ | DiceBear auto-generated avatars |
| **Local Persistence** | ✅ | Zustand with localStorage persistence |
| **Custom Domain** | 🟡 | Supported in CDK; deployment-dependent |

### Critical Path to MVP

```
[x] Types & Interfaces
[x] Telegram Adapter
[x] Message Evaluator
[x] Response Generator
[x] State Service (DynamoDB)
[x] LLM Service (Bedrock, OpenRouter, Anthropic + retry)
[x] Message Processor Handler (SQS consumer)
[x] Outbound Sender (execute response actions)
[x] Response Sender Handler
[x] CDK Infrastructure (SharedInfrastructure + AgentConstruct)
[x] Tool Definitions (send_message, react, ignore, wait, take_selfie)
[ ] Billing + entitlements (paid plans, subscription lifecycle)
[ ] Usage metering + spend controls (per-agent/tool usage tracking)
[ ] Memory opt-in + retention defaults (stateless free tier)
[ ] Deploy trigger from admin UI/API
[ ] Logs schema + correlation IDs + logs UI
[ ] Media callback contract (idempotent async jobs)
[ ] Agent template workflow (DB-backed; import/export optional)
[ ] First real agent config (firehorse, kyro, etc.)
[ ] End-to-end Telegram test
[ ] Deploy to AWS
```

---

## MVP Definition (Paid Platform)

To count as an MVP platform service, the system must let a user pay, activate a plan, and receive the corresponding runtime entitlements.

**Acceptance Criteria**
- Self-serve flow: create agent → connect Telegram → purchase plan → deploy → verify with logs.
- Paid entitlements enforced in runtime (memory opt-in, higher limits, premium tools).
- Free tier is stateless beyond request processing; paid tier explicitly enables durable memory.
- Usage metering for messages/tools/media with spend limits and exportable records.
- Telegram path is stable with an end-to-end test and canary playbook.

---

## Prioritized Plan (Next)

1) **Billing + Entitlements (MVP gate)**
   - Choose billing provider and plan model.
   - Implement subscription lifecycle and plan gating in runtime.

2) **Usage Metering + Spend Controls**
   - Track per-agent usage across handlers.
   - Enforce limits and expose usage in admin UI/API.

3) **Memory Opt-In + Retention**
   - Stateless free tier default.
   - Paid opt-in durable memory with retention windows and deletion/export flows.

4) **Control Plane Productization**
   - Deploy trigger from admin UI/API.
   - Template import/export + agent config versioning.

5) **Reliability + Observability**
   - Standardized logs + correlation IDs.
   - Media callback contract with idempotency + retries.
   - End-to-end Telegram test + canary rollout.

6) **Platform Expansion**
   - Harden X/Twitter adapter and complete Discord adapter.

## MCP Registration Plan

1) **Agent Scope Enforcement**
   - Require `agentId` in MCP metadata.
   - Reject requests missing agent scope.
   - Ensure tools/services enforce agent-scoped reads and writes.

2) **Client Registration**
   - Document MCP client setup (command, args, env, metadata).
   - Provide reference config for target clients (Claude Desktop, etc.).

3) **Deployment Mode**
   - Local stdio for dev; hosted MCP service for shared access.
   - Add rate limits and audit logging for MCP calls.

## Known Issues & Bugs

### Resolved

1. ~~**`state.ts` - Invalid DynamoDB Query**~~ **FIXED**
   - Changed from Query to Scan with FilterExpression
   - GSI added in CDK infrastructure for better performance

2. ~~**`llm/index.ts` - Placeholder Zod Schema Conversion**~~ **FIXED**
   - Added `zod-to-json-schema` package
   - Proper schema conversion implemented

3. ~~**`llm/index.ts` - Wrong Anthropic Provider**~~ **FIXED**
   - Dedicated `AnthropicLLMService` using `@anthropic-ai/sdk`

4. ~~**No retry/fallback logic for LLM calls**~~ **FIXED**
   - `RetryableLLMService` wrapper with exponential backoff + jitter

5. ~~**`isReplyToBot()` always returns false**~~ **FIXED**
   - Channel state lookup + Telegram raw message parsing

6. ~~**Missing DLQ handling**~~ **FIXED**
   - DLQ configured in CDK AgentConstruct for all queues

### Remaining Issues

7. **Ethereum wallet generation disabled**
    - `generateEthereumWallet` throws; needs ethers/viem implementation.

8. **Discord adapter missing**
    - Requires implementation and gateway vs interaction decision.

9. **Media pipeline callback contract is incomplete**
    - Response-sender queues media jobs but callback routing is stubbed; define SQS response queue + idempotency.

---

## Admin Interface (Conversational Setup)

### Overview

A web-based conversational interface for managing agents, secrets, and wallets. Protected by Cloudflare Access for secure authentication.

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         ADMIN INTERFACE ARCHITECTURE                              │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      CLOUDFLARE ACCESS (Zero Trust)                          │ │
│  │  • Fingerprint / WebAuthn                                                    │ │
│  │  • Google / GitHub / SAML SSO                                                │ │
│  │  • Hardware keys (YubiKey)                                                   │ │
│  │  • Access policies per user/group                                            │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      ADMIN WEB APP (packages/admin-ui)                       │ │
│  │                                                                               │ │
│  │  ┌───────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                    CONVERSATIONAL INTERFACE                            │  │ │
│  │  │                                                                        │  │ │
│  │  │  User: "Create a new agent called firehorse"                          │  │ │
│  │  │  Bot:  "I'll create firehorse. What platforms should it support?"     │  │ │
│  │  │  User: "Telegram and Twitter"                                          │  │ │
│  │  │  Bot:  "Great! I need the Telegram bot token. Please paste it:"       │  │ │
│  │  │  User: [pastes token]                                                  │  │ │
│  │  │  Bot:  "Token saved securely. Now for Twitter API keys..."            │  │ │
│  │  │                                                                        │  │ │
│  │  └───────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                               │ │
│  │  Frontend: React + Tailwind (or simple HTML/HTMX)                           │ │
│  │  Hosted: CloudFront + S3 (static) or Lambda@Edge                            │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      ADMIN API (Lambda + API Gateway)                        │ │
│  │                                                                               │ │
│  │  POST /chat                    → Conversational agent endpoint              │ │
│  │  GET  /agents                  → List agents (no secrets)                   │ │
│  │  POST /agents                  → Create agent                               │ │
│  │  GET/PUT/DELETE /agents/{id}   → Manage agent config                        │ │
│  │  GET/POST /agents/{id}/secrets → List/store secrets (no values)             │ │
│  │  POST /webhook/telegram/{id}   → Shared Telegram webhook                    │ │
│  │  POST /webhook/replicate       → Replicate callbacks (video jobs)           │ │
│  │  GET  /health                  → Health check                               │ │
│  │                                                                               │ │
│  │  Auth: Cloudflare Access JWT validation                                     │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      ADMIN AGENT (LLM with Tools)                            │ │
│  │                                                                               │ │
│  │  System Prompt:                                                              │ │
│  │  "You are a setup assistant for the Swarm agent platform. Help users        │ │
│  │   configure agents, set secrets, and manage wallets. Be helpful and         │ │
│  │   guide them through the process step by step."                             │ │
│  │                                                                               │ │
│  │  Tools (write-only for secrets):                                            │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │ │
│  │  │ create_agent    │  │ set_secret      │  │ generate_wallet │             │ │
│  │  │ list_agents     │  │ verify_secret   │  │ list_wallets    │             │ │
│  │  │ update_agent    │  │ delete_secret   │  │ get_balance     │             │ │
│  │  │ delete_agent    │  │ list_secret_keys│  │ request_airdrop │             │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘             │ │
│  │                                                                               │ │
│  │  IMPORTANT: Agent can SET secrets but NEVER READ them                       │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      SECURE STORAGE                                          │ │
│  │                                                                               │ │
│  │  AWS Secrets Manager                    AWS KMS                              │ │
│  │  ┌─────────────────────────────┐       ┌─────────────────────────────┐      │ │
│  │  │ swarm/shared/               │       │ swarm-master-key            │      │ │
│  │  │   OPENROUTER_API_KEY        │       │ (Customer Managed CMK)      │      │ │
│  │  │   REPLICATE_API_TOKEN       │       │ • Encrypt secrets           │      │ │
│  │  │                             │       │ • Encrypt wallet keys       │      │ │
│  │  │ swarm/{agentId}/secrets     │       │ • Key rotation enabled      │      │ │
│  │  │   TELEGRAM_BOT_TOKEN        │       └─────────────────────────────┘      │ │
│  │  │   TWITTER_API_KEY           │                                            │ │
│  │  │   (overrides shared)        │       DynamoDB (encrypted at rest)         │ │
│  │  │                             │       ┌─────────────────────────────┐      │ │
│  │  │ swarm/{agentId}/wallet      │       │ Agent configs               │      │ │
│  │  │   SOLANA_PRIVATE_KEY        │       │ Wallet metadata (no keys)   │      │ │
│  │  │   (encrypted with KMS)      │       │ Audit logs                  │      │ │
│  │  └─────────────────────────────┘       └─────────────────────────────┘      │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Admin Agent Tools

```typescript
// Tools available to the admin conversational agent
// SECURITY: Secrets are WRITE-ONLY - agent can set but never read values

const adminTools = [
  // ─────────────────────────────────────────────────────────────────
  // AGENT MANAGEMENT
  // ─────────────────────────────────────────────────────────────────
  {
    name: 'create_agent',
    description: 'Create a new agent with basic configuration',
    parameters: {
      id: 'Unique agent ID (lowercase, no spaces)',
      name: 'Display name',
      platforms: 'Array of platforms: telegram, twitter, discord, web',
    },
  },
  {
    name: 'list_agents',
    description: 'List all configured agents',
    // Returns: id, name, platforms, status (no secrets)
  },
  {
    name: 'update_agent_config',
    description: 'Update agent configuration (persona, behavior, etc)',
    parameters: {
      agentId: 'Agent to update',
      config: 'Partial config to merge',
    },
  },
  {
    name: 'delete_agent',
    description: 'Delete an agent (requires confirmation)',
    parameters: { agentId: 'Agent to delete' },
  },

  // ─────────────────────────────────────────────────────────────────
  // SECRETS MANAGEMENT (WRITE-ONLY)
  // ─────────────────────────────────────────────────────────────────
  {
    name: 'set_secret',
    description: 'Set a secret value. WRITE-ONLY - cannot read back.',
    parameters: {
      scope: '"shared" or agent ID',
      key: 'Secret key name (e.g., TELEGRAM_BOT_TOKEN)',
      value: 'Secret value (will be encrypted)',
    },
  },
  {
    name: 'verify_secret_exists',
    description: 'Check if a secret exists (does not reveal value)',
    parameters: {
      scope: '"shared" or agent ID',
      key: 'Secret key name',
    },
    // Returns: { exists: boolean, lastUpdated: timestamp }
  },
  {
    name: 'delete_secret',
    description: 'Delete a secret',
    parameters: {
      scope: '"shared" or agent ID',
      key: 'Secret key name',
    },
  },
  {
    name: 'list_secret_keys',
    description: 'List secret key names (not values) for an agent',
    parameters: { scope: '"shared" or agent ID' },
    // Returns: ['TELEGRAM_BOT_TOKEN', 'TWITTER_API_KEY', ...]
  },

  // ─────────────────────────────────────────────────────────────────
  // WALLET MANAGEMENT
  // ─────────────────────────────────────────────────────────────────
  {
    name: 'generate_wallet',
    description: 'Generate a new Solana wallet. Private key stored in Secrets Manager.',
    parameters: {
      agentId: 'Agent this wallet belongs to',
      label: 'Wallet label (e.g., "treasury", "tips")',
      cluster: 'mainnet-beta | devnet',
    },
    // Returns: { publicKey: '...', label: '...' } - NEVER returns private key
  },
  {
    name: 'list_wallets',
    description: 'List wallets for an agent (public keys only)',
    parameters: { agentId: 'Agent ID' },
    // Returns: [{ publicKey, label, cluster, balance }]
  },
  {
    name: 'get_wallet_balance',
    description: 'Get SOL and token balances for a wallet',
    parameters: {
      agentId: 'Agent ID',
      label: 'Wallet label',
    },
  },
  {
    name: 'request_devnet_airdrop',
    description: 'Request SOL airdrop on devnet for testing',
    parameters: {
      agentId: 'Agent ID',
      label: 'Wallet label',
      amount: 'SOL amount (max 2)',
    },
  },

  // ─────────────────────────────────────────────────────────────────
  // DEPLOYMENT
  // ─────────────────────────────────────────────────────────────────
  {
    name: 'trigger_deploy',
    description: 'Trigger CDK deployment for agent(s)',
    parameters: {
      agentIds: 'Array of agent IDs to deploy (or "all")',
      environment: 'dev | staging | prod',
    },
  },
  {
    name: 'get_deploy_status',
    description: 'Check deployment status',
    parameters: { deploymentId: 'Deployment ID from trigger_deploy' },
  },
];
```

### Secrets Hierarchy

```
swarm/
├── shared/                          # Global defaults (all agents can use)
│   ├── OPENROUTER_API_KEY          # Default AI API key
│   ├── REPLICATE_API_TOKEN         # Default media generation
│   └── ANTHROPIC_API_KEY           # Optional fallback
│
├── {agentId}/
│   ├── secrets                      # Agent-specific overrides
│   │   ├── TELEGRAM_BOT_TOKEN      # Required for Telegram
│   │   ├── TWITTER_API_KEY         # Required for Twitter
│   │   ├── TWITTER_API_SECRET
│   │   ├── TWITTER_ACCESS_TOKEN
│   │   ├── TWITTER_ACCESS_SECRET
│   │   ├── DISCORD_BOT_TOKEN       # Required for Discord
│   │   ├── OPENROUTER_API_KEY      # Override for cost tracking
│   │   └── ...
│   │
│   └── wallets/
│       ├── treasury                 # Main wallet
│       │   ├── publicKey
│       │   └── privateKey (encrypted with KMS)
│       └── tips                     # Tip collection wallet
│           ├── publicKey
│           └── privateKey (encrypted)
```

### Security Measures

#### 1. Authentication (Cloudflare Access)
```yaml
# Cloudflare Access Configuration
application:
  name: swarm-admin
  domain: admin.swarm.example.com

policies:
  - name: admin-access
    decision: allow
    include:
      - email_domain: yourdomain.com
      # Or specific emails
      - email:
          - admin@example.com
    require:
      # Require second factor
      - authentication_method:
          auth_method: mfa
      # Or specific methods
      - login_method:
          - otp
          - webauthn  # Fingerprint, face, hardware key
          - google
          - github
```

#### 2. API Security
```typescript
// Lambda middleware for Cloudflare Access JWT validation
async function validateCloudflareAccess(event: APIGatewayEvent): Promise<{
  valid: boolean;
  email?: string;
  error?: string;
}> {
  const cfHeader = event.headers['cf-access-jwt-assertion'];
  if (!cfHeader) {
    return { valid: false, error: 'Missing CF Access token' };
  }

  // Verify JWT with Cloudflare's public keys
  const certsUrl = `https://${CF_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const certs = await fetch(certsUrl).then(r => r.json());

  try {
    const decoded = jwt.verify(cfHeader, certs.public_certs[0].cert, {
      audience: CF_AUD_TAG,
      issuer: `https://${CF_TEAM_DOMAIN}`,
    });
    return { valid: true, email: decoded.email };
  } catch (err) {
    return { valid: false, error: 'Invalid token' };
  }
}
```

#### 3. Secrets Write-Only Enforcement
```typescript
// Secrets service for admin - WRITE-ONLY for values
class AdminSecretsService {
  private client: SecretsManagerClient;
  private kmsKeyId: string;

  // ✅ ALLOWED - Set secret (write)
  async setSecret(scope: string, key: string, value: string): Promise<void> {
    const secretId = scope === 'shared'
      ? `swarm/shared/${key}`
      : `swarm/${scope}/secrets`;

    // If storing in a JSON blob
    const existing = await this.getSecretStructure(secretId);
    existing[key] = value;

    await this.client.send(new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify(existing),
    }));

    // Audit log
    await this.logAudit('SET_SECRET', { scope, key, timestamp: Date.now() });
  }

  // ✅ ALLOWED - Verify exists (no value)
  async verifySecretExists(scope: string, key: string): Promise<{
    exists: boolean;
    lastUpdated?: number;
  }> {
    // Implementation returns boolean only
  }

  // ✅ ALLOWED - List keys (no values)
  async listSecretKeys(scope: string): Promise<string[]> {
    // Implementation returns key names only
  }

  // ✅ ALLOWED - Delete
  async deleteSecret(scope: string, key: string): Promise<void> {
    // Implementation
  }

  // ❌ NEVER IMPLEMENTED - No read method exists
  // getSecretValue() - DOES NOT EXIST
  // This is intentional - admin agent cannot read secrets
}
```

#### 4. Wallet Key Generation (In-Lambda)
```typescript
// Wallet generation happens entirely in Lambda
// Private keys NEVER leave AWS
class WalletService {
  private secretsClient: SecretsManagerClient;
  private kmsKeyId: string;

  async generateWallet(agentId: string, label: string, cluster: Cluster): Promise<{
    publicKey: string;
  }> {
    // Generate keypair IN LAMBDA (key never transmitted)
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const privateKey = bs58.encode(keypair.secretKey);

    // Encrypt private key with KMS before storing
    const kmsClient = new KMSClient({});
    const encrypted = await kmsClient.send(new EncryptCommand({
      KeyId: this.kmsKeyId,
      Plaintext: Buffer.from(privateKey),
    }));

    // Store in Secrets Manager (already encrypted by KMS)
    await this.secretsClient.send(new CreateSecretCommand({
      Name: `swarm/${agentId}/wallets/${label}`,
      SecretString: JSON.stringify({
        publicKey,
        privateKey: encrypted.CiphertextBlob.toString('base64'),
        cluster,
        createdAt: Date.now(),
      }),
      KmsKeyId: this.kmsKeyId,
    }));

    // Return ONLY public key
    return { publicKey };
  }

  // For agent runtime - decrypts in Lambda, never exposes
  async getWalletKeypair(agentId: string, label: string): Promise<Keypair> {
    const secret = await this.secretsClient.send(new GetSecretValueCommand({
      SecretId: `swarm/${agentId}/wallets/${label}`,
    }));

    const { privateKey: encryptedKey } = JSON.parse(secret.SecretString!);

    // Decrypt with KMS
    const kmsClient = new KMSClient({});
    const decrypted = await kmsClient.send(new DecryptCommand({
      KeyId: this.kmsKeyId,
      CiphertextBlob: Buffer.from(encryptedKey, 'base64'),
    }));

    const privateKey = Buffer.from(decrypted.Plaintext!).toString();
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  }
}
```

#### 5. Audit Logging
```typescript
// All admin actions are logged
interface AuditLog {
  timestamp: number;
  action: string;
  user: string;      // From Cloudflare Access JWT
  scope: string;     // Agent ID or 'shared'
  key?: string;      // Secret key (not value)
  metadata?: Record<string, unknown>;
}

// Stored in DynamoDB with TTL (90 days)
// PK: AUDIT#{year-month}
// SK: {timestamp}#{action}#{user}
```

### CDK Infrastructure for Admin

```typescript
// packages/infra/src/constructs/admin.ts

export class AdminConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AdminConstructProps) {
    super(scope, id);

    // KMS key for encrypting secrets and wallet keys
    const masterKey = new kms.Key(this, 'MasterKey', {
      alias: 'swarm-master-key',
      enableKeyRotation: true,
      description: 'Master key for Swarm secrets and wallet encryption',
    });

    // Admin API
    const adminApi = new apigateway.RestApi(this, 'AdminApi', {
      restApiName: 'swarm-admin-api',
      description: 'Admin API for Swarm management',
    });

    // Admin chat handler (conversational agent)
    const chatHandler = new lambda.Function(this, 'AdminChat', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'admin-chat.handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: {
        CLOUDFLARE_TEAM_DOMAIN: props.cloudflareTeamDomain,
        CLOUDFLARE_AUD_TAG: props.cloudflareAudTag,
        KMS_KEY_ID: masterKey.keyId,
      },
    });

    // Grant permissions
    masterKey.grantEncryptDecrypt(chatHandler);
    // Grant Secrets Manager write (but admin tools won't expose read)
    chatHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:ListSecrets',
        // Note: GetSecretValue is NOT granted to admin API
        // Only agent runtime Lambdas get read access
      ],
      resources: ['arn:aws:secretsmanager:*:*:secret:swarm/*'],
    }));

    // Static frontend (S3 + CloudFront)
    const adminBucket = new s3.Bucket(this, 'AdminFrontend', {
      websiteIndexDocument: 'index.html',
      publicReadAccess: false,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, 'AdminOAI');
    adminBucket.grantRead(oai);

    // CloudFront distribution (Cloudflare Access sits in front)
    new cloudfront.Distribution(this, 'AdminCdn', {
      defaultBehavior: {
        origin: new origins.S3Origin(adminBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
    });
  }
}
```

### Implementation Checklist

#### Admin Interface
- [x] Create `packages/admin-api/` - API handlers and services
- [x] Create `packages/admin-ui/` - React chat frontend
- [x] Implement admin API Lambda handlers (chat.ts)
- [x] Create admin agent with tools (20 tools implemented)
- [x] Add Cloudflare Access JWT validation
- [ ] Deploy static frontend to S3/CloudFront
- [ ] Configure admin.rati.chat domain

#### Secrets Management
- [x] Add `AdminSecretsService` (write-only)
- [x] Create KMS master key in CDK
- [x] Update secrets hierarchy for shared/agent-specific
- [ ] Add audit logging to DynamoDB
- [x] Remove read capability from admin tools

#### Wallet Management
- [x] Create `WalletService` for key generation
- [x] Implement in-Lambda keypair generation (Solana + Ethereum)
- [x] KMS encryption for private keys
- [ ] Add wallet balance checking tool
- [ ] Add devnet airdrop tool
- [ ] Improve Ethereum generation with ethers.js

#### Security
- [ ] Configure Cloudflare Access application
- [ ] Setup access policies (WebAuthn/fingerprint, Google, GitHub)
- [x] Validate JWT in Lambda handler
- [ ] Add audit logging for all admin actions
- [ ] Penetration testing

---

## Domain Setup: admin.rati.chat

### Overview

The admin interface will be available at `https://admin.rati.chat` with Cloudflare Access providing zero-trust authentication.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                  │
│   User Browser                                                                   │
│       │                                                                          │
│       ▼                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │            Cloudflare (DNS + Access + CDN)                               │   │
│   │                                                                          │   │
│   │   rati.chat (Zone)                                                       │   │
│   │     └── admin.rati.chat (CNAME → CloudFront)                            │   │
│   │                                                                          │   │
│   │   Cloudflare Access Application                                          │   │
│   │     • Name: Swarm Admin                                                  │   │
│   │     • Domain: admin.rati.chat                                            │   │
│   │     • Auth Methods: WebAuthn, Google, GitHub                             │   │
│   │     • Policy: Require MFA + Email allowlist                              │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│       │                                                                          │
│       │ CF-Access-JWT-Assertion header                                          │
│       ▼                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │            AWS (CloudFront + API Gateway)                                │   │
│   │                                                                          │   │
│   │   CloudFront Distribution                                                │   │
│   │     └── admin.rati.chat/* → S3 (static React app)                       │   │
│   │                                                                          │   │
│   │   API Gateway (HTTP API)                                                 │   │
│   │     └── /chat → Lambda (admin-chat handler)                             │   │
│   │     └── /health → Lambda (health check)                                  │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Step 1: Cloudflare DNS Setup

If rati.chat is already on Cloudflare:

```bash
# Add CNAME record for admin subdomain
# This will point to CloudFront after deployment

# Record Type: CNAME
# Name: admin
# Target: <cloudfront-distribution-id>.cloudfront.net
# Proxy: Yes (orange cloud)
# TTL: Auto
```

If rati.chat is NOT on Cloudflare:
1. Add site to Cloudflare (Free plan works)
2. Update nameservers at your registrar
3. Wait for propagation (up to 24h)

### Step 2: Cloudflare Access Configuration

Go to: `dash.cloudflare.com` → `Zero Trust` → `Access` → `Applications`

**Create Application:**
```yaml
Application:
  name: "Swarm Admin"
  type: "Self-hosted"
  session_duration: "24h"

Domain:
  - admin.rati.chat

Identity Providers:
  # Enable these in Zero Trust → Settings → Authentication
  - One-time PIN (email)
  - WebAuthn (fingerprint/face/hardware key)
  - Google
  - GitHub

Access Policies:
  - name: "Admin Access"
    action: "Allow"
    include:
      - Email:
          - "your-email@example.com"  # Add your email
    require:
      - Authentication Method: "mfa"  # Require 2FA
```

**Get Configuration Values:**
```bash
# After creating the application, note these values:
# 1. Team Domain: <your-team>.cloudflareaccess.com
# 2. Application Audience (AUD) tag: Found in Application settings

# These go into CDK environment variables:
CF_ACCESS_TEAM_DOMAIN=your-team
CF_ACCESS_AUD=32-character-audience-tag
ADMIN_EMAILS=your-email@example.com
```

### Step 3: Deploy Admin Infrastructure

```bash
cd packages/infra

# First, store the OpenRouter API key
aws secretsmanager create-secret \
  --name swarm/admin/llm-api-key \
  --secret-string "sk-or-your-openrouter-key-here"

# Deploy with Cloudflare configuration
cdk deploy SwarmAdminStack \
  --context cloudflareTeamDomain=your-team \
  --context adminEmails=your-email@example.com \
  --context environment=production
```

### Step 4: Deploy Admin UI to S3

```bash
cd packages/admin-ui

# Build the React app
pnpm build

# Get the S3 bucket name from CDK output
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name SwarmAdminStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AdminBucketName`].OutputValue' \
  --output text)

# Deploy to S3
aws s3 sync dist/ s3://$BUCKET_NAME/ --delete

# Invalidate CloudFront cache
DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name SwarmAdminStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AdminDistributionId`].OutputValue' \
  --output text)

aws cloudfront create-invalidation \
  --distribution-id $DISTRIBUTION_ID \
  --paths "/*"
```

### Step 5: Update Cloudflare CNAME

After deployment, get the CloudFront domain:

```bash
CLOUDFRONT_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name SwarmAdminStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AdminDistributionDomain`].OutputValue' \
  --output text)

echo "Add this CNAME in Cloudflare:"
echo "  Name: admin"
echo "  Target: $CLOUDFRONT_DOMAIN"
```

### Step 6: Configure UI API Endpoint

Update the admin UI to point to the API Gateway:

```typescript
// packages/admin-ui/src/api/chat.ts
const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT
  || 'https://api-id.execute-api.us-east-1.amazonaws.com';
```

Create `.env.production`:
```env
VITE_API_ENDPOINT=https://your-api-gateway-url.amazonaws.com
```

### Verification

After setup, test the flow:

1. **DNS:** `dig admin.rati.chat` should resolve to Cloudflare IPs
2. **Access:** Visit `https://admin.rati.chat` → Should show Cloudflare login
3. **Auth:** Log in with your configured method (fingerprint/Google/etc)
4. **API:** Send a chat message → Should get LLM response

### Environment Variables Reference

| Variable | Where | Value |
|----------|-------|-------|
| `CF_ACCESS_TEAM_DOMAIN` | CDK | Your Cloudflare team (e.g., `acme`) |
| `CF_ACCESS_AUD` | CDK | Application audience tag |
| `ADMIN_EMAILS` | CDK | Comma-separated admin emails |
| `LLM_API_KEY` | Secrets Manager | OpenRouter API key |
| `VITE_API_ENDPOINT` | Admin UI | API Gateway URL |

---

## File Structure with Status

```
aws-swarm/
├── README.md                            # [ ] NOT CREATED
│
├── packages/layer/                      # [x] DONE - Lambda Layer Dependencies
│   ├── package.json                     # AWS SDK, OpenAI deps
│   └── nodejs/                          # Built by CI workflow
│       └── node_modules/                # Installed at deploy time
│
├── packages/admin-api/                  # [x] DONE - Admin API Backend
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── types.ts                     # Type definitions
│       ├── auth/
│       │   ├── index.ts
│       │   └── cloudflare-access.ts     # JWT validation
│       ├── services/
│       │   ├── index.ts
│       │   ├── agents.ts                # Agent CRUD
│       │   ├── secrets.ts               # Write-only secrets
│       │   └── wallets.ts               # Wallet generation
│       └── handlers/
│           ├── index.ts
│           └── chat.ts                  # LLM chatbot with 20 tools
│
├── packages/admin-ui/                   # [x] DONE - Admin React Frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── index.html
│   ├── dist/                            # Built output (deployed to S3)
│   └── src/
│       ├── main.tsx
│       ├── index.css                    # Tailwind imports
│       ├── App.tsx                      # Main chat interface
│       ├── api/
│       │   ├── index.ts
│       │   └── chat.ts                  # API client
│       ├── types/
│       │   ├── index.ts
│       │   └── agent.ts                 # Agent, ChatMessage types
│       ├── store/
│       │   ├── index.ts
│       │   ├── chatStore.ts             # Legacy chat state
│       │   └── agents.ts                # Multi-agent store with persistence
│       └── components/
│           ├── index.ts
│           ├── Header.tsx
│           ├── ChatInput.tsx
│           ├── ChatMessage.tsx
│           ├── AgentSidebar.tsx         # Discord-like agent list
│           └── AgentConfigModal.tsx     # Agent configuration modal
│
├── package.json                         # [x] DONE
├── pnpm-workspace.yaml                  # [x] DONE
├── tsconfig.base.json                   # [x] DONE
│
├── agents/
│   └── .template/                       # [x] DONE
│       ├── config.yaml                  # Template for agent config
│       ├── persona.md                   # Template for agent persona
│       └── README.md
│
├── packages/infra/                      # [x] DONE
│   ├── package.json                     # [x] DONE
│   ├── tsconfig.json                    # [x] DONE
│   ├── bin/
│   │   └── swarm.ts                     # [x] DONE - CDK entry point
│   └── src/
│       ├── index.ts                     # [x] DONE
│       ├── stacks/
│       │   ├── index.ts                 # [x] DONE
│       │   └── swarm-stack.ts           # [x] DONE - Main stack
│       └── constructs/
│           ├── index.ts                 # [x] DONE
│           ├── shared.ts                # [x] DONE - DynamoDB, S3, CloudFront, Layer
│           ├── agent.ts                 # [x] DONE - SQS, API Gateway, Lambdas
│           ├── admin-api.ts             # [x] DONE - Admin API, KMS, DynamoDB
│           └── admin-ui.ts              # [x] DONE - S3, CloudFront, custom domain
│
├── packages/core/
│   ├── package.json                     # [x] DONE
│   ├── tsconfig.json                    # [x] DONE
│   └── src/
│       ├── index.ts                     # [x] DONE
│       ├── types/
│       │   └── index.ts                 # [x] DONE - Comprehensive types
│       ├── platforms/
│       │   ├── base.ts                  # [x] DONE - PlatformAdapter + Registry
│       │   ├── index.ts                 # [x] DONE
│       │   ├── telegram.ts              # [x] DONE - Full implementation
│       │   ├── twitter.ts               # [x] DONE - Tweet posting, mentions, media
│       │   ├── web.ts                   # [x] DONE - CORS, token gating, wallet auth
│       │   └── discord.ts               # [ ] MISSING
│       ├── processors/
│       │   ├── index.ts                 # [x] DONE
│       │   ├── message-evaluator.ts     # [x] DONE
│       │   ├── response-generator.ts    # [x] DONE
│       │   └── outbound-sender.ts       # [x] DONE
│       ├── services/
│       │   ├── index.ts                 # [x] DONE
│       │   ├── state.ts                 # [x] DONE
│       │   ├── activity.ts              # [x] DONE
│       │   ├── secrets.ts               # [x] DONE
│       │   ├── llm/
│       │   │   └── index.ts             # [x] DONE - Bedrock, OpenRouter, Anthropic + retry
│       │   ├── media/
│       │   │   └── index.ts             # [x] DONE - OpenRouter/Replicate/DALL-E
│       │   └── solana/
│       │       └── index.ts             # [x] DONE - Balance/transfer; NFT mint placeholder
│       └── utils/
│           ├── index.ts                 # [x] DONE
│           ├── logger.ts                # [x] DONE
│           └── config.ts                # [x] DONE
│
└── packages/handlers/
    ├── package.json                     # [x] DONE
    ├── tsconfig.json                    # [x] DONE
    └── src/
        ├── index.ts                     # [x] DONE
        ├── telegram-webhook.ts          # [x] DONE - Full implementation
        ├── message-processor.ts         # [x] DONE - Full implementation with tools
        ├── response-sender.ts           # [x] DONE - Full implementation
        ├── tweet-poster.ts              # [x] DONE - Scheduled tweets with LLM
        ├── twitter-mention-poller.ts    # [x] DONE - Polls mentions every 5 min
        └── web-chat.ts                  # [x] DONE - Sync chat with token gating
```

**Legend:** `[x]` Done | `[~]` Partial/Stub | `[ ]` Not Started

---

## What's Working

### Runtime Pipeline (Telegram via SQS)

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   API Gateway   │────▶│ telegram-webhook│────▶│  message-queue  │
│  POST /webhook  │     │    (Lambda)     │     │   (SQS FIFO)    │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                        ┌─────────────────┐              │
                        │message-processor│◀─────────────┘
                        │    (Lambda)     │
                        │ - Load config   │
                        │ - Call LLM      │
                        │ - Generate resp │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                        │ response-queue  │
                        │   (SQS FIFO)    │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐     ┌─────────────────┐
                        │ response-sender │────▶│    Telegram     │
                        │    (Lambda)     │     │      API        │
                        └─────────────────┘     └─────────────────┘
```

Admin API also exposes a shared Telegram webhook (`/webhook/telegram/{agentId}`) that
performs channel-aware buffering and calls the LLM/tools directly without the SQS pipeline.

### CDK Resources Created

**Shared (per environment):**
- DynamoDB: `swarm-state-{env}` (with GSI)
- DynamoDB: `swarm-activity-{env}`
- S3: `swarm-media-{env}-{account}`
- CloudFront distribution (prod only)
- Lambda Layer with dependencies

**Per Agent:**
- SQS: `{agentId}-messages.fifo`
- SQS: `{agentId}-responses.fifo`
- SQS: `{agentId}-media`
- SQS: `{agentId}-dlq.fifo`
- API Gateway: `{agentId}-api`
- Lambda: `{agentId}-telegram-webhook`
- Lambda: `{agentId}-message-processor`
- Lambda: `{agentId}-response-sender`
- Lambda: `{agentId}-web-chat` (if enabled)
- Lambda: `{agentId}-tweet-poster` (if scheduled)
- Lambda: `{agentId}-twitter-mention-poller` (if mention_replies enabled)
- EventBridge rule for tweet schedule
- EventBridge rule for mention polling (every 5 min)
- Secrets Manager: `swarm/{agentId}/secrets`

---

## Next Steps (Prioritized)

### Immediate (Reliability + Security)

1. **Fix Telegram webhook enforcement and reliability**
   - [x] Reject non-Telegram IPs when `ENFORCE_TELEGRAM_IP_CHECK` is on
   - [x] Move dedup marker after successful processing (or track status)
   - [x] Consume credits on successful `generate_image`/`generate_video`
   - [x] Make channel-state updates atomic (UpdateCommand/list_append)
   - [x] Add timeouts/retries for LLM + Telegram fetch calls
   - [x] Defer channel cooldown/response marking until send is confirmed
   - [x] Guard tool-call JSON parsing (reject/repair invalid tool args)
   - [x] Accept non-text Telegram updates (caption/media) in admin webhook

2. **Admin deployment verification**
   - [ ] Configure Cloudflare Access policies
   - [ ] Deploy Admin UI/API via GitHub Actions
   - [ ] Verify `/health` and `/chat` endpoints
   - [ ] Optional: wire custom domains in DNS/Cloudflare

3. **Admin feature gaps**
- [ ] Add audit logging service to DynamoDB
- [x] Add wallet balance tool (Solana)
- [ ] Re-enable Ethereum wallet generation with ethers/viem
- [ ] OpenRouter SDK + Zod tool refactor (`ZOD_REFACTOR.md`) - admin chat tools still JSON; no tools module detected
   - [ ] Feature flag for legacy tool loop fallback
   - [ ] Preserve manual tool pause flows (`request_secret`, `request_model_selection`, upload URLs)
   - [ ] Add schema validation error logging + sanitize error responses
   - [ ] Add manual-tool contract tests (secret, model selector, upload URL)
   - [ ] Normalize `pendingToolCall` payloads for admin UI compatibility
   - [ ] Add agent config import/export (DB-backed templates; no repo files)
   - [ ] Define agent template schema + versioning for DB storage
   - [ ] Add validation/migration for template import payloads
   - [ ] Ensure import/export excludes secrets (config/persona only)
   - [ ] Hook `request_model_selection` to a UI dropdown pause-flow
   - [ ] Build logs UI view for `GET /agents/{id}/logs`
   - [ ] Optional: deploy trigger integration (CodePipeline/Actions)

### Short-term (First Agent)

4. **Create first agent via Admin UI**
   - [ ] Use local UI or deployed UI to create agent
   - [ ] Configure Telegram platform and set bot token
   - [ ] Set global OpenRouter API key
   - [ ] Generate Solana wallet for agent

5. **Deploy and verify**
   - [ ] Push to `main` to trigger GitHub Actions deploy
   - [ ] Register Telegram webhook URL
   - [ ] Run end-to-end Telegram test

### Medium-term (Polish)

6. **Twitter & Web adapters**
   - [x] TwitterAdapter, tweet posting, mention poller
   - [x] WebAdapter with token gating
   - [ ] End-to-end testing

7. **Media generation in runtime pipeline**
   - [ ] Adopt SQS-first pipeline for media jobs (enqueue from response-sender)
   - [ ] Choose queue type (standard vs FIFO) and define ordering guarantees
   - [ ] Add media-processor Lambda to consume `MEDIA_QUEUE_URL` and fan-in callbacks
   - [ ] Add media-results SQS queue (or reuse response queue) for completed media callbacks
   - [ ] Define callback contract (prefer SQS response queue; avoid Lambda-name stub)
   - [ ] Add idempotency keys + dedupe to prevent double-sends on retries
   - [ ] Configure DLQ, visibility timeouts, and retry policies for media jobs
   - [ ] Handle payload size limits (SQS 256KB) via S3 pointers for large prompts/metadata
   - [ ] Add async video callback handling for runtime pipeline

8. **Testing**
   - [ ] Expand unit tests for MessageEvaluator/ResponseGenerator
   - [ ] Add integration tests with local DynamoDB
   - [ ] End-to-end test scripts for Telegram/Twitter/Web
   - [ ] Integration test for SQS media pipeline (queue → media-processor → callback)
   - [ ] UI flow tests for manual tools (request_secret, request_model_selection, upload URLs)

9. **Operational readiness**
   - [ ] Enable DynamoDB PITR + backup strategy for agent configs/state
   - [ ] Define secrets rotation policy + admin audit trail requirements
   - [ ] Add model allowlist/budget caps to control OpenRouter spend
   - [ ] Document DLQ redrive/runbook for media/message queues

### Long-term (Additional Platforms)

10. **Discord adapter**
   - [ ] Create DiscordAdapter class
   - [ ] Decide: Interaction webhooks vs Gateway (ECS Fargate)
   - [ ] Implement slash commands

11. **Observability**
    - [x] Consolidated logs API endpoint: `GET /agents/{agent_id}/logs`
    - [ ] Logs UI route: `rati.chat/agents/<agent_id>/logs`
    - [ ] Standardize structured logging fields (`agentId`, `level`, `component`) for reliable filters
    - [ ] CloudWatch dashboards
    - [ ] X-Ray tracing
    - [ ] CloudWatch alarms (Lambda errors, SQS queue depth, DLQ age)

12. **CLI Tool**
    - [ ] `swarm agent create <name>`
    - [ ] `swarm agent deploy <name>`
    - [ ] `swarm secrets set <agent> <key> <value>`

---

## Consolidated Logging (Agent Logs UI)

**Goal:** Provide a single, authenticated endpoint at `rati.chat/agents/<agent_id>/logs`
that returns everything for that agent (human UI + AI agents can `curl` one URL).
API endpoint exists; UI and log schema standardization remain.

### Data Sources
- **CloudWatch Logs** for all Lambdas (admin API, handlers, media/replicate webhooks).
- Optional: **S3 log archive** for long-term retention and low-cost search.

### Log Schema (JSON Structured)
Include these fields in every log event:
- `agentId`, `platform`, `conversationId`, `messageId`
- `service` (admin-api | handlers | infra), `component` (telegram-webhook | message-processor | response-sender)
- `requestId` (Lambda request ID), `traceId` (if tracing is enabled)
- `level`, `timestamp`, `event`, `error`

### Aggregation + Query Path
- **Short-term (fastest):** Use CloudWatch Logs Insights queries filtered by `agentId`.
- **Mid-term:** Add a CloudWatch Logs subscription to **OpenSearch** for indexed search.
- **Long-term:** Export to **S3** on a schedule for compliance and replay.

### UI + API
- **Admin API endpoint exists**: `GET /agents/{agentId}/logs` (CloudWatch Logs Insights).
  - Enforces Cloudflare Access auth + admin role.
  - Supports filters: time range, `level`, `subsystem/component`, free-text search.
  - Accepts query params like `?level=error&subsystem=telegram-webhook&since=1h`.
  - Requires consistent structured log fields for reliable filters.
- Admin UI route: `rati.chat/agents/<agent_id>/logs` with:
  - Live tail mode (polling) and history query mode.
  - Filters and quick presets (errors only, last 15m, by subsystem).

### Implementation Steps
1. Standardize JSON logging in all Lambdas (shared logger helper).
2. Add agentId-aware log fields to handlers and admin API.
3. Build admin UI view for logs (API already exists).
4. Optionally enable tracing (`traceId`) and OpenSearch indexing.

---

## Deployment Commands

```bash
# Build everything
pnpm install
pnpm build

# Deploy via GitHub Actions (preferred)
git push origin main

# Optional manual deploy (only if explicitly requested)
pnpm deploy:dev
pnpm deploy:prod

# Set Telegram webhook (after deploy)
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "<API_GATEWAY_URL>/webhook/telegram/<AGENT_ID>"}'
```

---

## Architecture Diagrams

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           AWS SWARM ARCHITECTURE                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                          AGENT REGISTRY                                      │ │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐                 │ │
│  │  │ FireHorse │  │   Kyro    │  │  Ratibot  │  │  Mirquo   │  + New Agents   │ │
│  │  │ persona/  │  │ persona/  │  │ persona/  │  │ persona/  │                 │ │
│  │  │ config    │  │ config    │  │ config    │  │ config    │                 │ │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘                 │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│  ┌───────────────────────────────────▼──────────────────────────────────────────┐│
│  │                       PLATFORM ADAPTERS (Shared)                              ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       ││
│  │  │ Telegram │  │ Discord  │  │ X/Twitter│  │   Web    │  │ Farcaster│       ││
│  │  │ [DONE]   │  │ [TODO]   │  │  [DONE]  │  │  [DONE]  │  │ [FUTURE] │       ││
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘       ││
│  └───────┼─────────────┼─────────────┼─────────────┼────────────────────────────┘│
│          │             │             │             │                              │
│          ▼             ▼             ▼             ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      MESSAGE ROUTER (API Gateway)                            │ │
│  │   POST /webhook/{platform}/{agent_id}  →  Route to correct agent context    │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         PROCESSING PIPELINE                                  │ │
│  │                                                                               │ │
│  │  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐                │ │
│  │  │ message-queue │───▶│ response-queue│───▶│  media-queue  │                │ │
│  │  │  (SQS FIFO)   │    │  (SQS FIFO)   │    │    (SQS)      │                │ │
│  │  └───────┬───────┘    └───────┬───────┘    └───────┬───────┘                │ │
│  │          │                    │                    │                         │ │
│  │          ▼                    ▼                    ▼                         │ │
│  │  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐                │ │
│  │  │   Evaluator   │    │ ResponseSender│    │ MediaProcessor│                │ │
│  │  │   + LLM Gen   │    │   (Lambda)    │    │   (Lambda)    │                │ │
│  │  │   (Lambda)    │    │ [DONE]        │    │ [TODO]        │                │ │
│  │  │ [DONE]        │    │               │    │               │                │ │
│  │  └───────────────┘    └───────────────┘    └───────────────┘                │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         SHARED SERVICES                                      │ │
│  │                                                                               │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │ │
│  │  │   State     │  │   Activity  │  │   Media     │  │   Secrets   │         │ │
│  │  │ (DynamoDB)  │  │ (DynamoDB)  │  │    (S3)     │  │  Manager    │         │ │
│  │  │ [DONE]      │  │ [DONE]      │  │ [DONE]      │  │ [DONE]      │         │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘         │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## DynamoDB Schema

```
Table: swarm-state-{env}
  PK: AGENT#{agentId}
  SK: Various patterns
    - CONFIG                          # Agent configuration
    - PLATFORM#{platform}#CONFIG      # Platform-specific config
    - CHANNEL#{channelId}#STATE       # Channel state + recent messages
    - USER#{userId}#COOLDOWN          # User cooldowns

  GSI1 (gsi1pk, gsi1sk):
    - For listing entities by type

Table: swarm-activity-{env}
  PK: AGENT#{agentId}
  SK: {timestamp}
  TTL: 24 hours (configurable)
```

---

## API Routes

```
# Admin API (admin-api)
POST /chat
GET/POST /agents
GET/PUT/DELETE /agents/{agentId}
GET/POST /agents/{agentId}/secrets
POST /webhook/telegram/{agentId}
POST /webhook/replicate
GET /health

# Runtime (handlers)
POST /webhook/telegram/{agentId}
POST /chat
GET /health
```

---

## Configuration Reference

### Agent config.yaml

```yaml
id: my-agent
name: My Agent
version: 1.0.0

platforms:
  telegram:
    enabled: true
    botUsername: my_agent_bot
  twitter:
    enabled: false
  web:
    enabled: false

llm:
  provider: openrouter  # openrouter | bedrock | anthropic
  model: anthropic/claude-sonnet-4
  temperature: 0.8
  maxTokens: 1024

media:
  image:
    provider: openrouter
    model: openai/dall-e-3

scheduling:
  tweet:
    hoursUtc: [12, 18]
    template: general

behavior:
  responseDelayMs: [1000, 3000]
  typingIndicator: true
  ignoreBots: true
  cooldownMinutes: 5
  maxContextMessages: 20

tools:
  - send_message
  - react
  - ignore
  - wait
  - take_selfie

secrets:
  - TELEGRAM_BOT_TOKEN
  - OPENROUTER_API_KEY
```

### Required Secrets (per agent)

Store in AWS Secrets Manager as `swarm/{agentId}/secrets`:

```json
{
  "TELEGRAM_BOT_TOKEN": "...",
  "OPENROUTER_API_KEY": "...",
  "TWITTER_API_KEY": "...",
  "TWITTER_API_SECRET": "...",
  "TWITTER_ACCESS_TOKEN": "...",
  "TWITTER_ACCESS_SECRET": "..."
}
```

---

## Cost Estimation

| Resource | Monthly Cost (estimate) |
|----------|------------------------|
| DynamoDB (on-demand) | $5-20 |
| Lambda (per 1M invocations) | $0.20 |
| SQS (per 1M requests) | $0.40 |
| S3 (per GB) | $0.023 |
| CloudFront (per GB) | $0.085 |
| Secrets Manager (per secret) | $0.40 |
| API Gateway (per 1M requests) | $1.00 |

**Estimated total for 4 agents with moderate traffic: $20-50/month**

---

## Decisions Made

### Core Architecture
- **Language:** TypeScript (better Lambda cold starts than Python)
- **Monorepo:** pnpm workspaces
- **CDK:** TypeScript CDK for infrastructure
- **Platform priority:** Telegram first, then Twitter/Web, Discord later
- **LLM default:** OpenRouter (multi-model access, fallback support)
- **Queues:** SQS FIFO for message ordering, standard for media
- **State:** Single DynamoDB table with composite keys (multi-tenant)

### Admin Interface
- **Auth:** Cloudflare Access (Zero Trust) with WebAuthn/fingerprint, Google, GitHub SSO
- **Interface:** Conversational chatbot (agentic) with admin tools
- **Secrets model:** Write-only in admin (agent can SET but never READ values)
- **Frontend:** React + Tailwind, hosted on S3 + CloudFront behind Cloudflare

### Security
- **Encryption:** AWS KMS CMK for all secrets and wallet keys
- **Wallet keys:** Generated IN Lambda, never leave AWS, encrypted at rest
- **API keys:** Shared defaults with per-agent overrides (for cost tracking)
- **Audit:** All admin actions logged to DynamoDB with 90-day TTL
- **IAM:** Admin API has no `secretsmanager:GetSecretValue` permission - only runtime Lambdas can read
