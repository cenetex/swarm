/**
 * Pause Tool Dispatch Registry
 *
 * Registry-driven dispatch for tools that pause the conversation for user input.
 * Replaces the brittle keyword-matching if/else chain in chat.ts with explicit
 * handler registrations.
 *
 * Each pause tool registers:
 * - A predicate to detect when it should pause (may depend on args)
 * - A payload builder to enrich the tool arguments for the UI
 * - A response text generator for the chat bubble
 *
 * @see https://github.com/atimics/aws-swarm/issues/65
 */

/**
 * Context available to pause tool handlers during dispatch.
 */
export interface PauseToolContext {
  avatarId: string;
  /** All tools built for the current request (used by executeUiTool) */
  tools: import('@openrouter/sdk').Tool[];
  /** MCP services for data fetching */
  mcpServices: {
    models: {
      listModels: (family?: string) => Promise<Array<{ id: string; name: string; pricing?: { prompt: string; completion: string }; contextLength?: number; context_length?: number; provider?: string }>>;
      getConfig: (avatarId: string) => Promise<{ model?: string } | null>;
    };
  };
}

/**
 * Result of a pause tool handler's payload builder.
 */
export interface PausePayloadResult {
  /** Enriched arguments for the UI (e.g., model list, feature toggle state) */
  args: Record<string, unknown>;
  /** If the UI tool name should differ from the original tool name */
  uiToolName?: string;
  /** Response text for the chat bubble */
  responseText: string;
}

/**
 * A registered handler for a single pause tool.
 */
export interface PauseToolHandler {
  /**
   * Whether this tool should pause given its name and arguments.
   * If not provided, the tool always pauses when matched by name.
   */
  shouldPause?: (args: Record<string, unknown>) => boolean;

  /**
   * Build the enriched payload for the UI. Receives the raw tool args and context.
   * If not provided, the raw args are passed through unchanged.
   */
  buildPayload?: (
    args: Record<string, unknown>,
    context: PauseToolContext
  ) => Promise<PausePayloadResult> | PausePayloadResult;

  /**
   * Build the response text for the chat bubble.
   * If buildPayload is provided and returns responseText, this is not needed.
   */
  responseText?: string | ((args: Record<string, unknown>) => string);
}

/**
 * Registry-driven dispatcher for pause tools.
 *
 * Usage:
 * ```ts
 * const dispatcher = new PauseToolDispatcher();
 * dispatcher.register('request_model_selection', { ... });
 * dispatcher.register('request_secret', { ... });
 *
 * if (dispatcher.shouldPause(toolName, args)) {
 *   const result = await dispatcher.dispatch(toolName, args, context);
 * }
 * ```
 */
export class PauseToolDispatcher {
  private handlers = new Map<string, PauseToolHandler>();

  /**
   * Register a pause tool handler.
   */
  register(toolName: string, handler: PauseToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  /**
   * Check if a tool name is registered as a pause tool.
   */
  has(toolName: string): boolean {
    return this.handlers.has(toolName);
  }

  /**
   * Check whether a tool call should pause the conversation for user input.
   */
  shouldPause(toolName: string, args?: Record<string, unknown>): boolean {
    const handler = this.handlers.get(toolName);
    if (!handler) return false;
    if (handler.shouldPause) {
      return handler.shouldPause(args ?? {});
    }
    return true;
  }

  /**
   * Dispatch a pause tool call: build the enriched payload and response text.
   * Returns null if the tool is not registered.
   */
  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    context: PauseToolContext
  ): Promise<PausePayloadResult | null> {
    const handler = this.handlers.get(toolName);
    if (!handler) return null;

    if (handler.buildPayload) {
      return handler.buildPayload(args, context);
    }

    // No custom builder: pass args through with default response text.
    const responseText = typeof handler.responseText === 'function'
      ? handler.responseText(args)
      : handler.responseText ?? 'Please provide the requested input.';

    return { args, responseText };
  }

  /**
   * Get all registered tool names.
   */
  getRegisteredNames(): string[] {
    return Array.from(this.handlers.keys());
  }
}

/**
 * Create and populate the default pause tool dispatcher with all known pause tools.
 * This is the canonical source of truth for which tools pause and how they are handled.
 */
export function createDefaultPauseDispatcher(deps: {
  buildModelSelectorPayload: (
    services: PauseToolContext['mcpServices']['models'],
    avatarId: string,
    family?: string
  ) => Promise<Record<string, unknown>>;
  buildFeatureTogglePayload: (
    avatarId: string,
    args: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  executeUiTool: (
    toolName: string,
    args: Record<string, unknown>,
    tools: import('@openrouter/sdk').Tool[]
  ) => Promise<Record<string, unknown>>;
}): PauseToolDispatcher {
  const dispatcher = new PauseToolDispatcher();

  // ── Model selection ──────────────────────────────────────────────────────
  dispatcher.register('request_model_selection', {
    buildPayload: async (args, ctx) => {
      const family = typeof args.family === 'string'
        ? args.family
        : typeof args.preferredFamily === 'string'
          ? args.preferredFamily
          : undefined;
      const enrichedArgs = await deps.buildModelSelectorPayload(
        ctx.mcpServices.models,
        ctx.avatarId,
        family
      );
      return { args: enrichedArgs, responseText: 'Please select a model:' };
    },
  });

  // ── Feature toggle ───────────────────────────────────────────────────────
  dispatcher.register('request_feature_toggle', {
    buildPayload: async (args, ctx) => {
      const enrichedArgs = await deps.buildFeatureTogglePayload(ctx.avatarId, args);
      return { args: enrichedArgs, responseText: 'Please choose your preference below:' };
    },
  });

  // ── Secret request ───────────────────────────────────────────────────────
  // Normalizes known integration secrets to configure_integration for UX consistency.
  dispatcher.register('request_secret', {
    buildPayload: async (args) => {
      const secretType = typeof args.secretType === 'string'
        ? args.secretType
        : typeof args.secretKey === 'string'
          ? args.secretKey
          : undefined;

      const SECRET_TO_INTEGRATION: Record<string, string> = {
        telegram_bot_token: 'telegram',
        telegram_webhook_secret: 'telegram',
        twitter_api_key: 'twitter',
        twitter_api_secret: 'twitter',
        twitter_access_token: 'twitter',
        twitter_access_secret: 'twitter',
        discord_bot_token: 'discord',
        replicate_api_key: 'replicate',
        replicate_api_token: 'replicate',
        openai_api_key: 'openai',
        anthropic_api_key: 'anthropic',
        openrouter_api_key: 'openrouter',
      };

      const integration = secretType ? SECRET_TO_INTEGRATION[secretType] : undefined;
      if (integration) {
        return {
          args: {
            integration,
            reason: typeof args.reason === 'string' ? args.reason : undefined,
          },
          uiToolName: 'configure_integration',
          responseText: '', // IntegrationConfigPrompt renders its own UI
        };
      }

      const label = typeof args.label === 'string'
        ? args.label
        : typeof args.secretType === 'string'
          ? args.secretType.replace(/_/g, ' ')
          : 'the requested secret';
      return { args, responseText: `Please enter ${label}.` };
    },
  });

  // ── Configure integration (direct) ──────────────────────────────────────
  dispatcher.register('configure_integration', {
    responseText: '', // IntegrationConfigPrompt renders its own UI
  });

  // ── Twitter connection ───────────────────────────────────────────────────
  // Both legacy (request_twitter_connection) and new (twitter_request_integration)
  // names are supported for backwards compatibility.
  const twitterHandler: PauseToolHandler = {
    buildPayload: async (args) => ({
      args: {
        integration: 'twitter',
        reason: typeof args.message === 'string' ? args.message : undefined,
        ...args,
      },
      uiToolName: 'configure_integration',
      responseText: '', // TwitterConnectPrompt renders its own UI
    }),
  };
  dispatcher.register('request_twitter_connection', twitterHandler);
  dispatcher.register('twitter_request_integration', twitterHandler);

  // ── Property research ────────────────────────────────────────────────────
  dispatcher.register('request_property_research', {
    responseText: 'Please grant property research access:',
  });

  // ── Upload URL tools ─────────────────────────────────────────────────────
  // Upload tools that need execution before pausing
  const executeAndPauseHandler: PauseToolHandler = {
    buildPayload: async (args, _ctx) => {
      // The caller passes the actual tool name; we identify which tool
      // from the args/context. We handle this at the dispatch call site
      // since we need the tool name which isn't part of the handler.
      // This is handled by the special _executeBeforePause path.
      return { args, responseText: 'Please upload your image:' };
    },
  };

  for (const toolName of [
    'get_profile_upload_url',
    'get_reference_image_upload_url',
    'get_character_reference_upload_url',
  ]) {
    dispatcher.register(toolName, executeAndPauseHandler);
  }

  // set_profile_image and set_character_reference only pause when source='upload'
  const conditionalUploadHandler: PauseToolHandler = {
    shouldPause: (args) => args.source === 'upload',
    buildPayload: async (args) => ({
      args,
      responseText: 'Please upload your image:',
    }),
  };
  dispatcher.register('set_profile_image', conditionalUploadHandler);
  dispatcher.register('set_character_reference', conditionalUploadHandler);

  return dispatcher;
}
