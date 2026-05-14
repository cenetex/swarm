/**
 * Mention Triage - Batch classification of mentions before full LLM processing
 * 
 * Uses a cheap/fast model to decide which mentions warrant a full response.
 * This saves cost by avoiding full LLM calls for mentions the avatar would ignore.
 */
import { DEFAULT_LLM_MODEL, logger, type SwarmEnvelope, type AvatarConfig } from '@swarm/core';

// Triage model - use a cheap, fast model
const TRIAGE_MODEL = process.env.TRIAGE_MODEL || DEFAULT_LLM_MODEL;
const TRIAGE_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const TRIAGE_TIMEOUT_MS = 15_000; // 15 seconds max for triage

export interface TriageDecision {
  mentionId: string;
  action: 'reply' | 'ignore';
  reason: string;
  priority?: 'high' | 'normal' | 'low';
}

export interface TriageResult {
  decisions: Map<string, TriageDecision>;
  triageTimeMs: number;
  modelUsed: string;
}

/**
 * Build a triage prompt that includes avatar persona and mention context
 */
function buildTriagePrompt(
  mentions: SwarmEnvelope[],
  avatarConfig: AvatarConfig
): string {
  const mentionList = mentions.map((m, i) => {
    const sender = m.sender.username || m.sender.displayName || 'anonymous';
    const text = m.content.text?.slice(0, 280) || '[no text]'; // Truncate for efficiency
    return `[${i}] @${sender}: ${text}`;
  }).join('\n');

  return `You are ${avatarConfig.name || 'an AI avatar'}. ${avatarConfig.persona || ''}

You have received ${mentions.length} mention(s) on Twitter. Review each and decide whether to reply.

**Decision Criteria:**
- REPLY: Interesting conversations, genuine questions, engaging banter, aligned with your personality
- IGNORE: Spam, low-effort replies, trolling, off-topic, not worth your time

**Mentions:**
${mentionList}

Respond with a JSON object containing your decisions:
{
  "decisions": [
    { "index": 0, "action": "reply" | "ignore", "reason": "brief reason", "priority": "high" | "normal" | "low" }
  ]
}

Be selective. You don't need to reply to everything. Consider: Would responding to this align with who you are?`;
}

/**
 * Parse the triage response from the LLM
 */
function parseTriageResponse(
  response: string,
  mentions: SwarmEnvelope[]
): Map<string, TriageDecision> {
  const decisions = new Map<string, TriageDecision>();

  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
    
    // Also try to find raw JSON object
    const rawJsonMatch = response.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
    if (rawJsonMatch) {
      jsonStr = rawJsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr.trim());
    
    if (!Array.isArray(parsed.decisions)) {
      throw new Error('Missing decisions array');
    }

    for (const decision of parsed.decisions) {
      const index = decision.index;
      if (typeof index !== 'number' || index < 0 || index >= mentions.length) {
        continue;
      }

      const mention = mentions[index];
      decisions.set(mention.messageId, {
        mentionId: mention.messageId,
        action: decision.action === 'ignore' ? 'ignore' : 'reply',
        reason: decision.reason || 'No reason provided',
        priority: decision.priority || 'normal',
      });
    }
  } catch (error) {
    logger.warn('Failed to parse triage response, defaulting to reply all', {
      event: 'triage_parse_error',
      subsystem: 'twitter',
      error: error instanceof Error ? error.message : String(error),
      responsePreview: response.slice(0, 200),
    });

    // Default: reply to all on parse failure
    for (const mention of mentions) {
      decisions.set(mention.messageId, {
        mentionId: mention.messageId,
        action: 'reply',
        reason: 'Triage parse failed, defaulting to reply',
        priority: 'normal',
      });
    }
  }

  return decisions;
}

/**
 * Triage a batch of mentions to decide which warrant a full LLM response
 */
export async function triageMentions(
  mentions: SwarmEnvelope[],
  avatarConfig: AvatarConfig,
  secrets: Record<string, string>
): Promise<TriageResult> {
  const startTime = Date.now();

  // If only 1-2 mentions, skip triage (not worth the overhead)
  if (mentions.length <= 2) {
    const decisions = new Map<string, TriageDecision>();
    for (const mention of mentions) {
      decisions.set(mention.messageId, {
        mentionId: mention.messageId,
        action: 'reply',
        reason: 'Small batch, skipping triage',
        priority: 'normal',
      });
    }
    return {
      decisions,
      triageTimeMs: Date.now() - startTime,
      modelUsed: 'none (batch too small)',
    };
  }

  const apiKey = secrets['OPENROUTER_API_KEY'] || secrets['openrouter_api_key'];
  if (!apiKey) {
    logger.warn('No API key for triage, defaulting to reply all', {
      event: 'triage_no_api_key',
      subsystem: 'twitter',
    });

    const decisions = new Map<string, TriageDecision>();
    for (const mention of mentions) {
      decisions.set(mention.messageId, {
        mentionId: mention.messageId,
        action: 'reply',
        reason: 'No API key for triage',
        priority: 'normal',
      });
    }
    return {
      decisions,
      triageTimeMs: Date.now() - startTime,
      modelUsed: 'none (no API key)',
    };
  }

  const prompt = buildTriagePrompt(mentions, avatarConfig);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRIAGE_TIMEOUT_MS);

  try {
    const response = await fetch(TRIAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://swarm.platform',
        'X-Title': 'Swarm Platform - Mention Triage',
      },
      body: JSON.stringify({
        model: TRIAGE_MODEL,
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature: 0.3, // Lower temperature for more consistent decisions
        max_tokens: 500,  // Keep response compact
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Triage API error: ${response.status} ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content || '';
    const decisions = parseTriageResponse(content, mentions);

    // Ensure all mentions have a decision (default to reply if missing)
    for (const mention of mentions) {
      if (!decisions.has(mention.messageId)) {
        decisions.set(mention.messageId, {
          mentionId: mention.messageId,
          action: 'reply',
          reason: 'Not included in triage response',
          priority: 'normal',
        });
      }
    }

    const ignoreCount = Array.from(decisions.values()).filter(d => d.action === 'ignore').length;
    const replyCount = decisions.size - ignoreCount;

    logger.info('Mention triage complete', {
      event: 'triage_complete',
      subsystem: 'twitter',
      avatarId: avatarConfig.id,
      totalMentions: mentions.length,
      replyCount,
      ignoreCount,
      triageTimeMs: Date.now() - startTime,
      model: TRIAGE_MODEL,
    });

    return {
      decisions,
      triageTimeMs: Date.now() - startTime,
      modelUsed: TRIAGE_MODEL,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    logger.warn('Triage failed, defaulting to reply all', {
      event: 'triage_failed',
      subsystem: 'twitter',
      error: error instanceof Error ? error.message : String(error),
      avatarId: avatarConfig.id,
    });

    // On failure, default to replying to all (safer than ignoring)
    const decisions = new Map<string, TriageDecision>();
    for (const mention of mentions) {
      decisions.set(mention.messageId, {
        mentionId: mention.messageId,
        action: 'reply',
        reason: 'Triage failed, defaulting to reply',
        priority: 'normal',
      });
    }

    return {
      decisions,
      triageTimeMs: Date.now() - startTime,
      modelUsed: `${TRIAGE_MODEL} (failed)`,
    };
  }
}

/**
 * Check if mention triage is enabled for an avatar
 */
export function isMentionTriageEnabled(
  twitterConfig: { features?: unknown; mentionTriage?: { enabled?: boolean } } | undefined
): boolean {
  // Check explicit mentionTriage config
  if (twitterConfig?.mentionTriage?.enabled !== undefined) {
    return twitterConfig.mentionTriage.enabled;
  }

  // Check if mention_triage feature flag is set
  if (Array.isArray(twitterConfig?.features)) {
    return (twitterConfig.features as string[]).includes('mention_triage');
  }

  // Default: disabled (opt-in feature)
  return false;
}
