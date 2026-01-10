/**
 * Admin Chatbot Handler
 * Conversational interface for setting up agents with tool use
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import * as agents from '../services/agents.js';
import * as secrets from '../services/secrets.js';
import * as wallets from '../services/wallets.js';
import type {
  AdminChatMessage,
  ToolCall,
  ToolResult,
  UserSession,
  SecretType,
} from '../types.js';

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

// Cache the API key after first fetch
let cachedApiKey: string | null = null;

async function getLlmApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  
  if (!LLM_API_KEY_SECRET_ARN) {
    throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  }

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({
    SecretId: LLM_API_KEY_SECRET_ARN,
  }));

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  // Parse JSON secret (handles {"api_key": "..."} format)
  try {
    const parsed = JSON.parse(response.SecretString);
    cachedApiKey = parsed.api_key || parsed.apiKey || parsed.API_KEY || response.SecretString;
  } catch {
    // Plain string secret
    cachedApiKey = response.SecretString;
  }

  return cachedApiKey!;
}

/**
 * Define available tools for the agent chatbot
 * These tools are agent-centric - the agent configures ITSELF
 * No agentId parameter needed - uses agent context from the chat
 */
const AGENT_TOOLS = [
  // Request secrets from user (shown as inline prompts in UI)
  {
    type: 'function',
    function: {
      name: 'request_secret',
      description: 'Request a secret value from the user. This will display a secure input field in the UI. Use this to collect API keys, tokens, and other sensitive credentials.',
      parameters: {
        type: 'object',
        properties: {
          secretType: { 
            type: 'string', 
            enum: [
              'telegram_bot_token',
              'discord_bot_token',
              'twitter_api_key', 'twitter_api_secret', 'twitter_access_token', 
              'twitter_access_secret', 'twitter_bearer_token',
              'helius_api_key', 'openrouter_api_key', 'anthropic_api_key', 'openai_api_key',
            ],
            description: 'Type of secret being requested' 
          },
          label: { type: 'string', description: 'Human-readable label for the input field' },
          instructions: { type: 'string', description: 'Brief instructions on how to get this secret' },
        },
        required: ['secretType', 'label'],
      },
    },
  },
  // Store a secret after user provides it
  {
    type: 'function',
    function: {
      name: 'store_secret',
      description: 'Store a secret value securely. Use after receiving a secret from request_secret.',
      parameters: {
        type: 'object',
        properties: {
          secretType: { 
            type: 'string', 
            enum: [
              'telegram_bot_token',
              'discord_bot_token',
              'twitter_api_key', 'twitter_api_secret', 'twitter_access_token', 
              'twitter_access_secret', 'twitter_bearer_token',
              'helius_api_key', 'openrouter_api_key', 'anthropic_api_key', 'openai_api_key',
            ],
            description: 'Type of secret' 
          },
          value: { type: 'string', description: 'The secret value to store' },
        },
        required: ['secretType', 'value'],
      },
    },
  },
  // Update my profile
  {
    type: 'function',
    function: {
      name: 'update_my_profile',
      description: 'Update my name, description, or persona',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'My display name' },
          description: { type: 'string', description: 'Brief description of what I do' },
          persona: { type: 'string', description: 'My personality/system prompt' },
        },
      },
    },
  },
  // Solana wallet management
  {
    type: 'function',
    function: {
      name: 'create_solana_wallet',
      description: 'Create a new Solana wallet for myself. The private key is stored securely.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the wallet (e.g., "main", "tips", "treasury")' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_wallets',
      description: 'List all my Solana wallets with their public keys and balances',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_wallet_balance',
      description: 'Get the SOL balance and token balances for a specific wallet',
      parameters: {
        type: 'object',
        properties: {
          publicKey: { type: 'string', description: 'The wallet public key/address' },
        },
        required: ['publicKey'],
      },
    },
  },
  // List my configured secrets (not values, just what's set)
  {
    type: 'function',
    function: {
      name: 'get_my_secrets',
      description: 'List which secrets I have configured (not the values, just which types are set)',
      parameters: { type: 'object', properties: {} },
    },
  },
  // Deploy myself via GitHub Actions
  {
    type: 'function',
    function: {
      name: 'deploy_myself',
      description: 'Deploy myself to production. Triggers a GitHub Actions workflow to deploy my configuration.',
      parameters: {
        type: 'object',
        properties: {
          environment: { 
            type: 'string', 
            enum: ['staging', 'production'],
            description: 'Environment to deploy to' 
          },
        },
        required: ['environment'],
      },
    },
  },
];

interface AgentContext {
  id: string;
  name: string;
  description?: string;
  persona?: string;
}

function buildSystemPrompt(agent?: AgentContext): string {
  if (agent) {
    return `You are ${agent.name}, an AI agent being configured by your owner.
${agent.description ? `Your purpose: ${agent.description}` : ''}
${agent.persona ? `Your personality: ${agent.persona}` : ''}

You are setting yourself up. The user is your owner who is helping configure you.

## Your Capabilities

You can request and store secrets for various integrations:
- **Telegram**: Request bot token from @BotFather
- **Discord**: Request bot token from Discord Developer Portal
- **Twitter/X**: Request API credentials
- **Helius**: Request API key for Solana RPC (for wallet balance lookups)
- **AI Providers**: OpenRouter, Anthropic, OpenAI API keys

You can manage your Solana wallets:
- Create new wallets (private keys stored securely, you only see public keys)
- Check balances of your wallets (SOL and tokens)
- Share your public wallet addresses

You can update your profile:
- Change your name, description, and persona

You can deploy yourself:
- Trigger deployment to staging or production via GitHub Actions

## How to Request Secrets

When the user wants to set up an integration (e.g., "setup telegram"), use the request_secret tool to prompt them for the credentials. This shows a secure input field in the UI. After they submit, use store_secret to save it.

Example flow:
1. User: "set up telegram"
2. You: Use request_secret with secretType="telegram_bot_token"
3. UI shows secure input
4. User submits token
5. You: Use store_secret to save it
6. Confirm success

## Security Notes
- Secrets are stored in AWS Secrets Manager with KMS encryption
- You can SET secrets but never READ their values
- Wallet private keys are generated securely and stored encrypted
- You can only see public keys and balances

Be friendly, helpful, and guide your owner through setup step by step.`;
  }

  // Fallback for no agent context
  return `You are a Swarm agent assistant. Please select an agent to chat with.`;
}

/**
 * Execute a tool call
 * Agent-centric: all operations use the agent's own ID from context
 */
async function executeTool(
  toolCall: ToolCall,
  session: UserSession,
  agentContext?: AgentContext
): Promise<ToolResult> {
  const { name, arguments: argsString } = toolCall.function;

  try {
    const args = JSON.parse(argsString);
    
    // Most tools require agent context
    if (!agentContext && !['request_secret'].includes(name)) {
      throw new Error('Agent context required for this operation');
    }
    
    const agentId = agentContext?.id;
    let result: unknown;

    switch (name) {
      // Request a secret from the user - returns a prompt for the UI
      case 'request_secret':
        result = { 
          type: 'secret_request',
          secretType: args.secretType,
          label: args.label,
          instructions: args.instructions,
          agentId,
        };
        break;
        
      // Store a secret securely
      case 'store_secret':
        await secrets.storeSecret(
          agentId!,
          args.secretType as SecretType,
          'default',
          args.value,
          session,
          `${args.secretType} for agent ${agentId}`
        );
        result = { success: true, message: `${args.secretType} stored securely` };
        break;
        
      // Update my profile
      case 'update_my_profile':
        result = await agents.updateAgent(agentId!, {
          name: args.name,
          description: args.description,
          persona: args.persona,
        }, session);
        break;
        
      // Create a Solana wallet
      case 'create_solana_wallet':
        result = await wallets.generateSolanaWallet(agentId!, args.name, session);
        break;
        
      // List my wallets
      case 'get_my_wallets': {
        const walletList = await wallets.listWallets(agentId!);
        // Enrich with balances
        const enriched = await Promise.all(
          walletList
            .filter(w => w.walletType === 'solana')
            .map(async (w) => {
              try {
                const balance = await wallets.getSolanaBalance(w.publicKey, agentId);
                return { ...w, balance };
              } catch {
                return { ...w, balance: null };
              }
            })
        );
        result = enriched;
        break;
      }
        
      // Get specific wallet balance
      case 'get_wallet_balance':
        result = await wallets.getSolanaBalance(args.publicKey, agentId);
        break;
        
      // List my configured secrets
      case 'get_my_secrets':
        result = await secrets.listSecrets(agentId!);
        break;
        
      // Deploy myself via GitHub Actions
      case 'deploy_myself':
        // TODO: Trigger GitHub Actions workflow
        result = { 
          type: 'deploy_request',
          environment: args.environment,
          agentId,
          message: `Deployment to ${args.environment} will be triggered via GitHub Actions`,
          note: 'GitHub Actions integration pending'
        };
        break;
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      content: JSON.stringify(result, null, 2),
    };
  } catch (error) {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      content: JSON.stringify({ 
        error: true, 
        message: error instanceof Error ? error.message : 'Unknown error' 
      }),
    };
  }
}

// Import type for LLM config moved to top

/**
 * Call the LLM API
 */
async function callLLM(
  messages: AdminChatMessage[],
  agent?: AgentContext
): Promise<{ 
  message?: string; 
  toolCalls?: ToolCall[]; 
}> {
  const apiKey = await getLlmApiKey();
  const systemPrompt = buildSystemPrompt(agent);
  
  const response = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://swarm.admin',
      'X-Title': 'Swarm Admin',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      tools: AGENT_TOOLS,
      tool_choice: 'auto',
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error: ${response.status} ${text}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: ToolCall[];
      };
    }>;
  };
  const choice = data.choices?.[0];
  
  if (!choice) {
    throw new Error('No response from LLM');
  }

  return {
    message: choice.message?.content,
    toolCalls: choice.message?.tool_calls,
  };
}

/**
 * Process a chat message, executing tools as needed
 */
async function processChat(
  userMessage: string,
  conversationHistory: AdminChatMessage[],
  session: UserSession,
  agent?: AgentContext
): Promise<{ 
  response: string; 
  history: AdminChatMessage[]; 
}> {
  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  let response: string | undefined;
  let iterations = 0;
  const maxIterations = 10; // Prevent infinite loops

  while (iterations < maxIterations) {
    iterations++;
    
    const llmResponse = await callLLM(messages, agent);
    
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: llmResponse.message || '',
        tool_calls: llmResponse.toolCalls,
      });

      // Execute all tool calls
      const toolResults = await Promise.all(
        llmResponse.toolCalls.map(tc => executeTool(tc, session, agent))
      );

      // Add tool results
      for (const result of toolResults) {
        messages.push(result as AdminChatMessage);
      }

      // Continue the loop to get the next response
      continue;
    }

    // No tool calls, we have a final response
    response = llmResponse.message || 'I apologize, but I couldn\'t generate a response.';
    messages.push({ role: 'assistant', content: response });
    break;
  }

  if (!response) {
    response = 'I apologize, but I exceeded the maximum number of tool calls. Please try again with a simpler request.';
    messages.push({ role: 'assistant', content: response });
  }

  return { response, history: messages };
}

/**
 * Lambda handler for admin chat API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
  };

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate the request
    const session = await authenticateRequest(event);
    
    // Require admin access
    if (!requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { message, history = [], agent } = body;

    if (!message || typeof message !== 'string') {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Message is required' }),
      };
    }

    // Process the chat with agent context
    const result = await processChat(message, history, session, agent);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: result.response,
        history: result.history,
      }),
    };
  } catch (error) {
    console.error('Chat handler error:', error);
    
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
