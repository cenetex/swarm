/**
 * Twitter/X Platform Adapter
 * Handles Twitter API v2 for posting, mentions, and DMs
 */
import { TwitterApi, TweetV2, UserV2 } from 'twitter-api-v2';
import { PlatformAdapter } from './base.js';
import type {
  AgentConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  TwitterConfig,
} from '../types/index.js';

export interface TwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export class TwitterAdapter extends PlatformAdapter {
  readonly platform = 'twitter' as const;
  private client: TwitterApi | null = null;
  private config: TwitterConfig;
  private botUserId: string | null = null;

  constructor(agentConfig: AgentConfig, private readonly credentials: TwitterCredentials) {
    super(agentConfig);
    this.config = agentConfig.platforms.twitter!;
    
    if (this.isConfigured()) {
      this.client = new TwitterApi({
        appKey: credentials.appKey,
        appSecret: credentials.appSecret,
        accessToken: credentials.accessToken,
        accessSecret: credentials.accessSecret,
      });
    }
  }

  isConfigured(): boolean {
    return !!(
      this.config?.enabled &&
      this.credentials.appKey &&
      this.credentials.appSecret &&
      this.credentials.accessToken &&
      this.credentials.accessSecret
    );
  }

  getDisplayName(): string {
    return `Twitter @${this.config.username}`;
  }

  async verifyRequest(_body: Buffer, _headers: Record<string, string>): Promise<boolean> {
    // Twitter uses CRC token verification for webhooks
    // For Account Activity API, implement CRC validation
    // For polling-based approach, this isn't used
    return true;
  }

  /**
   * Parse a tweet into SwarmEnvelope
   * Used when processing mentions or timeline tweets
   */
  async parseMessage(body: unknown): Promise<SwarmEnvelope | null> {
    const tweet = body as TweetV2 & { 
      author?: UserV2;
      author_id?: string;
    };
    
    if (!tweet.id || !tweet.text) {
      return null;
    }

    const sender = await this.extractSender(tweet);
    const content = this.extractContent(tweet);
    const mentions = this.extractMentions(tweet);

    const envelope = this.createBaseEnvelope({
      messageId: tweet.id,
      conversationId: tweet.conversation_id || tweet.id,
      timestamp: tweet.created_at ? new Date(tweet.created_at).getTime() : Date.now(),
      sender,
      content,
      raw: tweet,
    });

    envelope.mentions = mentions;
    envelope.replyTo = tweet.referenced_tweets?.find(r => r.type === 'replied_to')?.id;

    return envelope;
  }

  async executeAction(
    action: ResponseAction,
    _conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    try {
      switch (action.type) {
        case 'send_message':
          await this.postTweet(action.text, action.media, replyToMessageId);
          break;

        case 'react':
          // Twitter "reaction" is a like
          await this.client.v2.like(await this.getBotUserId(), action.messageId);
          break;

        case 'wait':
          await new Promise(resolve => setTimeout(resolve, action.durationMs));
          break;

        case 'ignore':
          // No action needed
          break;

        default:
          console.warn(`Unknown action type: ${(action as ResponseAction).type}`);
      }
      
      return true;
    } catch (error) {
      console.error('Failed to execute Twitter action:', error);
      return false;
    }
  }

  async sendTypingIndicator(_conversationId: string): Promise<void> {
    // Twitter doesn't have typing indicators for tweets
    // Could be implemented for DMs
  }

  /**
   * Post a tweet with optional media
   */
  async postTweet(
    text: string,
    media?: Array<{ type: string; url: string }>,
    replyToTweetId?: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
    };

    // Handle reply
    if (replyToTweetId) {
      tweetParams.reply = {
        in_reply_to_tweet_id: replyToTweetId,
      };
    }

    // Handle media upload
    if (media && media.length > 0) {
      const mediaIds: string[] = [];
      
      for (const item of media) {
        try {
          // Download the media and upload to Twitter
          const response = await fetch(item.url);
          const buffer = Buffer.from(await response.arrayBuffer());
          
          const mediaId = await this.client.v1.uploadMedia(buffer, {
            mimeType: item.type === 'video' ? 'video/mp4' : 'image/png',
          });
          
          mediaIds.push(mediaId);
        } catch (error) {
          console.error('Failed to upload media to Twitter:', error);
        }
      }

      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Get recent mentions of the bot
   */
  async getMentions(sinceId?: string): Promise<SwarmEnvelope[]> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const userId = await this.getBotUserId();
    
    const mentions = await this.client.v2.userMentionTimeline(userId, {
      since_id: sinceId,
      max_results: 20,
      expansions: ['author_id', 'referenced_tweets.id'],
      'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id'],
      'user.fields': ['username', 'name'],
    });

    const envelopes: SwarmEnvelope[] = [];
    
    for (const tweet of mentions.data.data || []) {
      const author = mentions.includes?.users?.find(u => u.id === tweet.author_id);
      const envelope = await this.parseMessage({ ...tweet, author });
      if (envelope) {
        envelopes.push(envelope);
      }
    }

    return envelopes;
  }

  /**
   * Quote tweet with optional image
   */
  async quoteTweet(
    text: string,
    quoteTweetId: string,
    media?: Array<{ type: string; url: string }>
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
      quote_tweet_id: quoteTweetId,
    };

    if (media && media.length > 0) {
      const mediaIds: string[] = [];
      
      for (const item of media.slice(0, 4)) {
        const response = await fetch(item.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const mediaId = await this.client.v1.uploadMedia(buffer, {
          mimeType: item.type === 'video' ? 'video/mp4' : 'image/png',
        });
        mediaIds.push(mediaId);
      }

      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Get the bot's Twitter user ID
   */
  private async getBotUserId(): Promise<string> {
    if (this.botUserId) {
      return this.botUserId;
    }

    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const me = await this.client.v2.me();
    this.botUserId = me.data.id;
    return this.botUserId;
  }

  /**
   * Extract sender info from tweet
   */
  private async extractSender(tweet: TweetV2 & { author?: UserV2; author_id?: string }): Promise<SenderInfo> {
    const author = tweet.author;
    
    return {
      id: tweet.author_id || author?.id || 'unknown',
      username: author?.username,
      displayName: author?.name,
      isBot: false, // Twitter doesn't expose bot status easily
      platform: 'twitter',
      platformUserId: tweet.author_id || author?.id || 'unknown',
    };
  }

  /**
   * Extract content from tweet
   */
  private extractContent(tweet: TweetV2): MessageContent {
    return {
      text: tweet.text,
      // Note: Media extraction requires additional API calls with expansions
    };
  }

  /**
   * Extract mentions from tweet
   */
  private extractMentions(tweet: TweetV2): SwarmEnvelope['mentions'] {
    const mentions: SwarmEnvelope['mentions'] = [];
    
    // Extract @mentions from tweet text using regex
    const mentionRegex = /@(\w+)/g;
    let match;
    
    while ((match = mentionRegex.exec(tweet.text)) !== null) {
      mentions.push({
        userId: match[1], // We only have username, not ID
        username: match[1],
        offset: match.index,
        length: match[0].length,
      });
    }

    return mentions;
  }

  /**
   * Get the underlying TwitterApi client for advanced usage
   */
  getClient(): TwitterApi | null {
    return this.client;
  }
}
