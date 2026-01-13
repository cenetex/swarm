/**
 * Tweet Poster Handler
 * Posts scheduled tweets with optional AI-generated images
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createLLMService,
  createMediaService,
  logger,
  type AgentConfig,
} from '@swarm/core';

// Environment variables
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const AGENT_ID = process.env.AGENT_ID!;
const TWEET_TEMPLATE = process.env.TWEET_TEMPLATE || 'general';

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let twitterAdapter: TwitterAdapter;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  agentConfig = await stateService.getAgentConfig(AGENT_ID) || {
    id: AGENT_ID,
    name: AGENT_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      twitter: { enabled: true, username: '', features: ['scheduled_tweets'] },
    },
    llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.9, maxTokens: 280 },
    media: { image: { provider: 'replicate', model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db' } }, // flux-schnell
    scheduling: {},
    behavior: { responseDelayMs: [0, 0], typingIndicator: false, ignoreBots: true, cooldownMinutes: 0, maxContextMessages: 0 },
    tools: [],
    secrets: [],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AGENT_ID}/secrets`
  );

  twitterAdapter = new TwitterAdapter(agentConfig, {
    appKey: secrets.TWITTER_API_KEY,
    appSecret: secrets.TWITTER_API_SECRET,
    accessToken: secrets.TWITTER_ACCESS_TOKEN,
    accessSecret: secrets.TWITTER_ACCESS_SECRET,
  });
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  logger.setContext({
    agentId: AGENT_ID,
    platform: 'twitter',
    requestId: context.awsRequestId,
    template: TWEET_TEMPLATE,
  });

  try {
    await initialize();

    logger.info('Generating scheduled tweet');

    // Generate tweet content using LLM
    const llmService = createLLMService(agentConfig.llm, secrets);
    
    const systemPrompt = `${agentConfig.persona}

You are posting a tweet. Generate a single tweet that:
- Is engaging and authentic to your personality
- Is under 280 characters
- Does not use hashtags excessively (max 1-2 if any)
- Feels natural, not promotional
- Template type: ${TWEET_TEMPLATE}

Respond with ONLY the tweet text, nothing else.`;

    const response = await llmService.generateResponse({
      agentId: AGENT_ID,
      systemPrompt,
      messages: [{ role: 'user', content: 'Generate a tweet.' }],
      config: { ...agentConfig.llm, temperature: 0.95 },
    });

    let tweetText = response.content.trim();
    
    // Ensure tweet is under 280 chars
    if (tweetText.length > 280) {
      tweetText = tweetText.slice(0, 277) + '...';
    }

    logger.info('Tweet generated', { text: tweetText, length: tweetText.length });

    // Optionally generate an image
    let mediaUrl: string | undefined;
    
    // 30% chance to include an image
    if (Math.random() < 0.3) {
      try {
  const mediaService = createMediaService(secrets, MEDIA_BUCKET, CDN_URL);
        
        const imagePromptResponse = await llmService.generateResponse({
          agentId: AGENT_ID,
          systemPrompt: `Generate a short image prompt (under 100 chars) for an image to accompany this tweet: "${tweetText}"
          
The image should be visually interesting and relate to the tweet content.
Respond with ONLY the image prompt, nothing else.`,
          messages: [{ role: 'user', content: 'Generate image prompt.' }],
          config: { ...agentConfig.llm, maxTokens: 100 },
        });

        const imagePrompt = imagePromptResponse.content.trim();
        logger.info('Generating tweet image', { prompt: imagePrompt });

        const media = await mediaService.generateImage(imagePrompt, agentConfig.media.image);
        mediaUrl = media.url;
        
        logger.info('Image generated', { url: mediaUrl });
      } catch (error) {
        logger.warn('Image generation failed, posting without image', error instanceof Error ? { error: error.message } : undefined);
      }
    }

    // Post the tweet
    const tweetId = await twitterAdapter.postTweet(
      tweetText,
      mediaUrl ? [{ type: 'image', url: mediaUrl }] : undefined
    );

    logger.info('Tweet posted', { tweetId });

    // Log activity
    await activityService.log({
      agentId: AGENT_ID,
      timestamp: Date.now(),
      eventType: 'response_sent',
      platform: 'twitter',
      summary: `Posted tweet: ${tweetText.slice(0, 50)}...`,
      details: { tweetId, hasImage: !!mediaUrl },
    });

  } catch (error) {
    logger.error('Failed to post tweet', error);
    
    await activityService.logError(
      AGENT_ID,
      'twitter',
      error instanceof Error ? error.message : String(error)
    );
    
    throw error;
  }
};
