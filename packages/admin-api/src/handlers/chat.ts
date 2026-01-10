/**
 * Admin Chatbot Handler
 * Conversational interface for setting up agents with tool use
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
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
  AgentRecord,
} from '../types.js';

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_API_KEY = process.env.LLM_API_KEY!;
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

/**
 * Define available tools for the admin chatbot
 */
const ADMIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_agent',
      description: 'Create a new agent/bot that can be configured to work across platforms',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name for the agent' },
          description: { type: 'string', description: 'Brief description of what the agent does' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List all agents in the swarm',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agent',
      description: 'Get details about a specific agent',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_agent',
      description: 'Update agent settings like name, description, or persona',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent to update' },
          name: { type: 'string', description: 'New name' },
          description: { type: 'string', description: 'New description' },
          persona: { type: 'string', description: 'Persona/system prompt for the agent' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_telegram',
      description: 'Enable and configure Telegram for an agent. The bot token should be set separately using set_telegram_token.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          botUsername: { type: 'string', description: 'The Telegram bot username (without @)' },
        },
        required: ['agentId', 'botUsername'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_telegram_token',
      description: 'Set the Telegram bot token for an agent. This is a write-only operation - the token cannot be read back.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          botToken: { type: 'string', description: 'The Telegram bot token from BotFather' },
        },
        required: ['agentId', 'botToken'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_twitter',
      description: 'Enable and configure Twitter/X for an agent. API credentials should be set separately.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          username: { type: 'string', description: 'The Twitter username (without @)' },
        },
        required: ['agentId', 'username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_twitter_credentials',
      description: 'Set Twitter API credentials for an agent. This is a write-only operation.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          apiKey: { type: 'string', description: 'Twitter API Key' },
          apiSecret: { type: 'string', description: 'Twitter API Secret' },
          accessToken: { type: 'string', description: 'Twitter Access Token' },
          accessSecret: { type: 'string', description: 'Twitter Access Token Secret' },
          bearerToken: { type: 'string', description: 'Twitter Bearer Token' },
        },
        required: ['agentId', 'apiKey', 'apiSecret', 'accessToken', 'accessSecret'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_discord',
      description: 'Enable and configure Discord for an agent. Bot credentials should be set separately.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          guildId: { type: 'string', description: 'Discord server ID (optional, for single-server bots)' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_discord_credentials',
      description: 'Set Discord bot credentials for an agent. This is a write-only operation.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          botToken: { type: 'string', description: 'Discord bot token' },
          clientId: { type: 'string', description: 'Discord application client ID' },
          clientSecret: { type: 'string', description: 'Discord application client secret' },
        },
        required: ['agentId', 'botToken'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_ai_provider_key',
      description: 'Set an AI provider API key. Can be global (for all agents) or per-agent (for cost tracking).',
      parameters: {
        type: 'object',
        properties: {
          provider: { 
            type: 'string', 
            enum: ['openrouter', 'anthropic', 'openai', 'replicate'],
            description: 'The AI provider' 
          },
          apiKey: { type: 'string', description: 'The API key' },
          agentId: { type: 'string', description: 'Optional agent ID for per-agent keys. Omit for global key.' },
        },
        required: ['provider', 'apiKey'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_llm',
      description: 'Configure LLM settings for an agent',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          provider: { 
            type: 'string', 
            enum: ['openrouter', 'bedrock', 'anthropic', 'openai'],
            description: 'LLM provider to use' 
          },
          model: { type: 'string', description: 'Model name (e.g., anthropic/claude-sonnet-4)' },
          temperature: { type: 'number', description: 'Temperature (0-1)' },
          maxTokens: { type: 'number', description: 'Max tokens to generate' },
          useGlobalKey: { type: 'boolean', description: 'Whether to use global API key or agent-specific' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_solana_wallet',
      description: 'Generate a new Solana wallet for an agent. Private key is stored securely and cannot be read.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          name: { type: 'string', description: 'Name for the wallet (e.g., "main", "tips")' },
        },
        required: ['agentId', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_ethereum_wallet',
      description: 'Generate a new Ethereum wallet for an agent. Private key is stored securely and cannot be read.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
          name: { type: 'string', description: 'Name for the wallet (e.g., "main", "tips")' },
        },
        required: ['agentId', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_wallets',
      description: 'List wallets for an agent. Only shows public addresses, not private keys.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_secrets',
      description: 'List configured secrets for an agent. Shows which secrets are set, but NOT their values.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Optional agent ID. Omit to list global secrets.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_secret',
      description: 'Delete a secret from an agent configuration',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent ID (omit for global secrets)' },
          secretType: { 
            type: 'string', 
            enum: [
              'telegram_bot_token',
              'twitter_api_key', 'twitter_api_secret', 'twitter_access_token', 
              'twitter_access_secret', 'twitter_bearer_token',
              'discord_bot_token', 'discord_client_id', 'discord_client_secret',
              'openrouter_api_key', 'anthropic_api_key', 'openai_api_key', 'replicate_api_key',
            ],
            description: 'Type of secret to delete' 
          },
        },
        required: ['secretType'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deploy_agent',
      description: 'Deploy an agent to AWS. This will create the necessary infrastructure.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the agent to deploy' },
        },
        required: ['agentId'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are the Swarm Admin Assistant, helping users set up and manage their social media agents.

You can help users:
- Create new agents with names and descriptions
- Configure platform integrations (Telegram, Twitter/X, Discord)
- Set API credentials securely (note: you can SET secrets but never READ them back - this is by design for security)
- Generate crypto wallets (Solana, Ethereum) with secure key storage
- Configure LLM settings (provider, model, temperature)
- Deploy agents to AWS

Important security notes:
1. All API keys and tokens are stored securely in AWS Secrets Manager with KMS encryption
2. You can SET secrets but never READ their values - this is a write-only security pattern
3. You can verify which secrets are configured by listing them
4. Private keys for crypto wallets are generated in secure Lambda functions and stored encrypted

When users provide API keys or tokens, use the appropriate tool to store them immediately.
Always confirm when secrets are successfully stored.

Be friendly and helpful. Guide users through the setup process step by step if they're not sure what to do.`;

/**
 * Execute a tool call
 */
async function executeTool(
  toolCall: ToolCall,
  session: UserSession
): Promise<ToolResult> {
  const { name, arguments: argsString } = toolCall.function;
  
  try {
    const args = JSON.parse(argsString);
    let result: unknown;
    
    switch (name) {
      case 'create_agent':
        result = await agents.createAgent(args.name, session, args.description);
        break;
        
      case 'list_agents':
        result = await agents.listAgents();
        break;
        
      case 'get_agent':
        result = await agents.getAgent(args.agentId);
        if (!result) throw new Error(`Agent not found: ${args.agentId}`);
        break;
        
      case 'update_agent':
        result = await agents.updateAgent(args.agentId, {
          name: args.name,
          description: args.description,
          persona: args.persona,
        }, session);
        break;
        
      case 'configure_telegram':
        result = await agents.configureTelegram(args.agentId, args.botUsername, session);
        break;
        
      case 'set_telegram_token':
        await secrets.storeTelegramSecrets(args.agentId, args.botToken, session);
        result = { success: true, message: 'Telegram bot token stored securely' };
        break;
        
      case 'configure_twitter':
        result = await agents.configureTwitter(args.agentId, args.username, session);
        break;
        
      case 'set_twitter_credentials':
        await secrets.storeTwitterSecrets(
          args.agentId,
          {
            apiKey: args.apiKey,
            apiSecret: args.apiSecret,
            accessToken: args.accessToken,
            accessSecret: args.accessSecret,
            bearerToken: args.bearerToken,
          },
          session
        );
        result = { success: true, message: 'Twitter credentials stored securely' };
        break;
        
      case 'configure_discord':
        result = await agents.configureDiscord(args.agentId, args.guildId, session);
        break;
        
      case 'set_discord_credentials':
        await secrets.storeDiscordSecrets(
          args.agentId,
          {
            botToken: args.botToken,
            clientId: args.clientId,
            clientSecret: args.clientSecret,
          },
          session
        );
        result = { success: true, message: 'Discord credentials stored securely' };
        break;
        
      case 'set_ai_provider_key':
        await secrets.storeAIProviderKey(args.provider, args.apiKey, session, args.agentId);
        result = { 
          success: true, 
          message: args.agentId 
            ? `${args.provider} API key stored for agent ${args.agentId}`
            : `Global ${args.provider} API key stored`
        };
        break;
        
      case 'configure_llm':
        const llmConfig: Record<string, unknown> = {};
        if (args.provider) llmConfig.provider = args.provider;
        if (args.model) llmConfig.model = args.model;
        if (args.temperature !== undefined) llmConfig.temperature = args.temperature;
        if (args.maxTokens !== undefined) llmConfig.maxTokens = args.maxTokens;
        if (args.useGlobalKey !== undefined) llmConfig.useGlobalKey = args.useGlobalKey;
        
        const existing = await agents.getAgent(args.agentId);
        if (!existing) throw new Error(`Agent not found: ${args.agentId}`);
        
        result = await agents.updateAgent(args.agentId, {
          llmConfig: { ...existing.llmConfig, ...llmConfig } as AgentRecord['llmConfig'],
        }, session);
        break;
        
      case 'generate_solana_wallet':
        result = await wallets.generateSolanaWallet(args.agentId, args.name, session);
        break;
        
      case 'generate_ethereum_wallet':
        result = await wallets.generateEthereumWallet(args.agentId, args.name, session);
        break;
        
      case 'list_wallets':
        result = await wallets.listWallets(args.agentId);
        break;
        
      case 'list_secrets':
        result = await secrets.listSecrets(args.agentId);
        break;
        
      case 'delete_secret':
        await secrets.deleteSecret(args.agentId || null, args.secretType as SecretType, args.secretType, session);
        result = { success: true, message: `Secret ${args.secretType} deleted` };
        break;
        
      case 'deploy_agent':
        // TODO: Trigger CDK deployment
        result = { 
          success: true, 
          message: 'Agent deployment initiated. Check AWS console for status.',
          note: 'CDK deployment integration pending'
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
  messages: AdminChatMessage[]
): Promise<{ 
  message?: string; 
  toolCalls?: ToolCall[]; 
}> {
  const response = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
      'HTTP-Referer': 'https://swarm.admin',
      'X-Title': 'Swarm Admin',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
      tools: ADMIN_TOOLS,
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
  session: UserSession
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
    
    const llmResponse = await callLLM(messages);
    
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: llmResponse.message || '',
        tool_calls: llmResponse.toolCalls,
      });

      // Execute all tool calls
      const toolResults = await Promise.all(
        llmResponse.toolCalls.map(tc => executeTool(tc, session))
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
    const { message, history = [] } = body;

    if (!message || typeof message !== 'string') {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Message is required' }),
      };
    }

    // Process the chat
    const result = await processChat(message, history, session);

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
