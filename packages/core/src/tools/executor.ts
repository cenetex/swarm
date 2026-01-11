/**
 * Platform Tool Executor
 * Executes tools on behalf of agents when responding on platforms
 */
import type { AgentConfig, ToolCall, ResponseAction } from '../types/index.js';

export interface ToolExecutorDependencies {
  agentId: string;
  agentConfig: AgentConfig;
  secrets: Record<string, string>;
  wallets?: Array<{ name: string; publicKey: string }>;
  mediaBucket?: string;
  cdnUrl?: string;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  actions?: ResponseAction[];
}

/**
 * Execute a tool call and return the result
 */
export async function executeToolCall(
  toolCall: ToolCall,
  deps: ToolExecutorDependencies
): Promise<ToolExecutionResult> {
  const { name, input } = toolCall;
  const args = (input || {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'send_message':
        return {
          success: true,
          actions: [{
            type: 'send_message',
            text: args.text as string,
            replyToMessageId: args.reply_to as string | undefined,
          }],
        };

      case 'react':
        return {
          success: true,
          actions: [{
            type: 'react',
            emoji: args.emoji as string,
            messageId: args.message_id as string,
          }],
        };

      case 'wait':
        return {
          success: true,
          actions: [{
            type: 'wait',
            durationMs: (args.seconds as number) * 1000,
            reason: args.reason as string | undefined,
          }],
        };

      case 'ignore':
        return {
          success: true,
          data: { ignored: true, reason: args.reason },
        };

      case 'take_selfie':
      case 'generate_image':
        return await executeImageGeneration(args as { prompt: string; style?: string }, deps);

      case 'get_my_wallet':
        return executeGetWallet(deps);

      case 'check_wallet_balance':
        return await executeCheckBalance(deps);

      case 'remember':
        return {
          success: false,
          error: 'Memory tools are disabled until durable storage is enabled.',
        };

      case 'recall':
        return {
          success: false,
          error: 'Memory tools are disabled until durable storage is enabled.',
        };

      case 'send_sticker':
        return {
          success: true,
          actions: [{
            type: 'send_sticker',
            emoji: args.emoji as string,
          }],
        };

      default:
        return {
          success: false,
          error: `Unknown tool: ${name}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Tool execution failed',
    };
  }
}

/**
 * Execute image generation tool
 */
async function executeImageGeneration(
  args: { prompt: string; style?: string },
  deps: ToolExecutorDependencies
): Promise<ToolExecutionResult> {
  const apiKey = deps.secrets['REPLICATE_API_KEY'] || deps.secrets['replicate_api_key'];
  
  if (!apiKey) {
    return {
      success: false,
      error: 'No Replicate API key configured for image generation',
    };
  }

  // Build prompt with agent's character for selfies
  let finalPrompt = args.prompt;
  if (args.style) {
    finalPrompt += `, ${args.style} style`;
  }

  // Add agent name context for selfies
  if (deps.agentConfig.name) {
    finalPrompt = `${deps.agentConfig.name}: ${finalPrompt}`;
  }

  try {
    // Use Replicate's Flux model
    const response = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${apiKey}`,
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        version: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db', // flux-schnell
        input: {
          prompt: finalPrompt,
          width: 1024,
          height: 1024,
          num_outputs: 1,
          output_format: 'png',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Replicate API error: ${response.status} - ${errorText}`);
    }

    let prediction = await response.json() as {
      id: string;
      status: string;
      output?: string | string[];
      error?: string;
    };

    // Poll if needed (Prefer: wait should handle most cases)
    let attempts = 0;
    while (prediction.status === 'starting' || prediction.status === 'processing') {
      if (attempts++ > 60) {
        throw new Error('Image generation timed out');
      }
      await new Promise(r => setTimeout(r, 1000));

      const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { 'Authorization': `Token ${apiKey}` },
      });
      prediction = await pollResponse.json() as typeof prediction;
    }

    if (prediction.status === 'failed') {
      throw new Error(prediction.error || 'Image generation failed');
    }

    const imageUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;

    if (!imageUrl) {
      throw new Error('No image returned');
    }

    return {
      success: true,
      data: { imageUrl, prompt: finalPrompt },
      actions: [{
        type: 'send_media',
        mediaType: 'image',
        url: imageUrl,
        caption: args.prompt,
      }],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Image generation failed',
    };
  }
}

/**
 * Get wallet info
 */
function executeGetWallet(deps: ToolExecutorDependencies): ToolExecutionResult {
  const mainWallet = deps.wallets?.find(w => w.name === 'main') || deps.wallets?.[0];

  if (!mainWallet) {
    return {
      success: true,
      data: { message: 'No wallet configured yet' },
    };
  }

  return {
    success: true,
    data: {
      name: mainWallet.name,
      publicKey: mainWallet.publicKey,
    },
  };
}

/**
 * Check wallet balance
 */
async function executeCheckBalance(deps: ToolExecutorDependencies): Promise<ToolExecutionResult> {
  const mainWallet = deps.wallets?.find(w => w.name === 'main') || deps.wallets?.[0];

  if (!mainWallet) {
    return {
      success: true,
      data: { message: 'No wallet configured yet', balance: 0 },
    };
  }

  try {
    // Use Helius or public RPC
    const rpcUrl = deps.secrets['HELIUS_RPC_URL'] || 'https://api.mainnet-beta.solana.com';
    
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [mainWallet.publicKey],
      }),
    });

    const data = await response.json() as {
      result?: { value: number };
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(data.error.message);
    }

    const lamports = data.result?.value || 0;
    const sol = lamports / 1_000_000_000;

    return {
      success: true,
      data: {
        publicKey: mainWallet.publicKey,
        balance: sol,
        balanceFormatted: `${sol.toFixed(4)} SOL`,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to check balance',
    };
  }
}

/**
 * Process multiple tool calls and collect actions
 */
export async function processToolCalls(
  toolCalls: ToolCall[],
  deps: ToolExecutorDependencies
): Promise<{ results: ToolExecutionResult[]; actions: ResponseAction[] }> {
  const results: ToolExecutionResult[] = [];
  const actions: ResponseAction[] = [];

  for (const toolCall of toolCalls) {
    const result = await executeToolCall(toolCall, deps);
    results.push(result);

    if (result.actions) {
      actions.push(...result.actions);
    }
  }

  return { results, actions };
}
