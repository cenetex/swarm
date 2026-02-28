/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Twitter OAuth 1.0a Service
 * Handles 3-legged OAuth flow for connecting X/Twitter accounts to avatars
 *
 * Flow:
 * 1. User clicks "Connect X Account" → /oauth/twitter/start?avatarId=xxx
 * 2. We get request token from Twitter, store it, redirect user to Twitter
 * 3. User authorizes on Twitter → redirected back to /oauth/twitter/callback
 * 4. We exchange request token for access token, store in Secrets Manager
 */
import { TwitterApi } from 'twitter-api-v2';
import {
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import * as secretsServiceDefault from '../secrets.js';
import type { UserSession } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';

/**
 * Dependencies interface for Twitter OAuth service (for testing)
 */
export interface TwitterOAuthServiceDeps {
  dynamoClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (command: any) => Promise<any>;
  };
  secretsClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (command: any) => Promise<any>;
  };
  secretsService: {
    storeSecret: typeof secretsServiceDefault.storeSecret;
    deleteSecret: typeof secretsServiceDefault.deleteSecret;
    getSecretValue: typeof secretsServiceDefault.getSecretValue;
  };
  TwitterApi: typeof TwitterApi;
  tableName: string;
  oauthCallbackUrl: string;
  appCredentialsArn: string;
}

const defaultDynamoClient = getDynamoClient();
const defaultSecretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const OAUTH_CALLBACK_URL = process.env.TWITTER_OAUTH_CALLBACK_URL || '';

// ARN for Twitter app credentials secret
const TWITTER_APP_CREDENTIALS_ARN = process.env.TWITTER_APP_CREDENTIALS_ARN || 'swarm/global/twitter-app-credentials';

// Default dependencies
const defaultDeps: TwitterOAuthServiceDeps = {
  dynamoClient: defaultDynamoClient,
  secretsClient: defaultSecretsClient,
  secretsService: secretsServiceDefault,
  TwitterApi: TwitterApi,
  tableName: ADMIN_TABLE,
  oauthCallbackUrl: OAUTH_CALLBACK_URL,
  appCredentialsArn: TWITTER_APP_CREDENTIALS_ARN,
};

// Cached credentials
let cachedAppCredentials: { appKey: string; appSecret: string } | null = null;

/**
 * Reset cached credentials - ONLY for testing
 * @internal
 */
export function _resetCacheForTesting(): void {
  cachedAppCredentials = null;
}

/**
 * Get Twitter app credentials from Secrets Manager
 */
async function getAppCredentials(deps: TwitterOAuthServiceDeps = defaultDeps): Promise<{ appKey: string; appSecret: string } | null> {
  if (cachedAppCredentials) {
    return cachedAppCredentials;
  }

  try {
    const response = await deps.secretsClient.send(new GetSecretValueCommand({
      SecretId: deps.appCredentialsArn,
    })) as { SecretString?: string };

    if (!response.SecretString) {
      return null;
    }

    const parsed = JSON.parse(response.SecretString);
    cachedAppCredentials = {
      appKey: parsed.TWITTER_APP_KEY || parsed.consumer_key || parsed.consumerKey,
      appSecret: parsed.TWITTER_APP_SECRET || parsed.consumer_secret || parsed.consumerSecret,
    };
    return cachedAppCredentials;
  } catch (error) {
    // Don't log the full error object as it may contain sensitive credentials
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to get Twitter app credentials: ${errorMessage}`);
    return null;
  }
}

interface OAuthRequestToken {
  pk: string;           // OAUTH#TWITTER#<oauth_token>
  sk: string;           // OAUTH_REQUEST
  avatarId: string;
  oauthToken: string;
  oauthTokenSecret: string;
  createdAt: number;
  ttl: number;          // Expire after 10 minutes
}

/**
 * Check if Twitter OAuth is configured
 */
export async function isConfigured(deps: TwitterOAuthServiceDeps = defaultDeps): Promise<boolean> {
  const creds = await getAppCredentials(deps);
  return !!(creds?.appKey && creds?.appSecret && deps.oauthCallbackUrl);
}

/**
 * Smoke-test Twitter OAuth configuration by attempting to create an auth link.
 *
 * This performs a network call to Twitter (request token endpoint) but does NOT
 * store any tokens in DynamoDB and does not return the URL/token to callers.
 */
export async function probeOAuthStart(deps: TwitterOAuthServiceDeps = defaultDeps): Promise<void> {
  const creds = await getAppCredentials(deps);
  if (!creds || !deps.oauthCallbackUrl) {
    throw new Error('Twitter OAuth not configured. Ensure swarm/global/twitter-app-credentials secret exists and TWITTER_OAUTH_CALLBACK_URL is set.');
  }

  const client = new deps.TwitterApi({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
  });

  try {
    await client.generateAuthLink(deps.oauthCallbackUrl, { linkMode: 'authorize' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'twitter-oauth',
      event: 'oauth_probe_failed',
      oauthCallbackUrl: deps.oauthCallbackUrl,
      error: message,
    }));

    if (/\b403\b/.test(message) || /code\s*403/i.test(message)) {
      throw new Error(
        `Twitter rejected the OAuth request (HTTP 403). Verify your X Developer app settings allow the callback URL: ${deps.oauthCallbackUrl}`
      );
    }

    throw new Error(`Twitter OAuth probe failed: ${message}`);
  }
}

/**
 * Start the OAuth flow - get request token and return authorization URL
 */
export async function startOAuthFlow(avatarId: string, deps: TwitterOAuthServiceDeps = defaultDeps): Promise<{
  authorizationUrl: string;
  oauthToken: string;
}> {
  const creds = await getAppCredentials(deps);
  if (!creds || !deps.oauthCallbackUrl) {
    throw new Error('Twitter OAuth not configured. Ensure swarm/global/twitter-app-credentials secret exists and TWITTER_OAUTH_CALLBACK_URL is set.');
  }

  // Create a client for getting request token
  const client = new deps.TwitterApi({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
  });

  // Get request token with callback URL
  let url: string;
  let oauth_token: string;
  let oauth_token_secret: string;
  try {
    ({ url, oauth_token, oauth_token_secret } = await client.generateAuthLink(
      deps.oauthCallbackUrl,
      { linkMode: 'authorize' } // 'authorize' asks every time, 'authenticate' auto-approves if already authorized
    ));
  } catch (error) {
    // twitter-api-v2 throws rich errors; surface a helpful, non-sensitive message.
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'twitter-oauth',
      event: 'oauth_start_failed',
      avatarId,
      oauthCallbackUrl: deps.oauthCallbackUrl,
      error: message,
    }));

    // Common case: Twitter rejects callback URL or app permissions (often manifests as 403).
    if (/\b403\b/.test(message) || /code\s*403/i.test(message)) {
      throw new Error(
        `Twitter rejected the OAuth request (HTTP 403). Verify your X Developer app settings allow the callback URL: ${deps.oauthCallbackUrl}`
      );
    }

    throw new Error(
      `Failed to start Twitter OAuth flow: ${message}`
    );
  }

  // Store the request token temporarily (needed to complete the flow)
  const now = Date.now();
  const record: OAuthRequestToken = {
    pk: `OAUTH#TWITTER#${oauth_token}`,
    sk: 'OAUTH_REQUEST',
    avatarId,
    oauthToken: oauth_token,
    oauthTokenSecret: oauth_token_secret,
    createdAt: now,
    ttl: Math.floor(now / 1000) + 600, // Expire in 10 minutes
  };

  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: record,
  }));

  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'twitter-oauth',
    event: 'oauth_flow_started',
    avatarId,
    oauthToken: oauth_token,
  }));

  return {
    authorizationUrl: url,
    oauthToken: oauth_token,
  };
}

/**
 * Complete the OAuth flow - exchange request token for access token
 */
export async function completeOAuthFlow(
  oauthToken: string,
  oauthVerifier: string,
  session: UserSession,
  deps: TwitterOAuthServiceDeps = defaultDeps
): Promise<{
  success: boolean;
  avatarId: string;
  username?: string;
  userId?: string;
  error?: string;
}> {
  const creds = await getAppCredentials(deps);
  if (!creds) {
    throw new Error('Twitter OAuth not configured');
  }

  // Retrieve the stored request token
  const result = await deps.dynamoClient.send(new GetCommand({
    TableName: deps.tableName,
    Key: {
      pk: `OAUTH#TWITTER#${oauthToken}`,
      sk: 'OAUTH_REQUEST',
    },
  })) as { Item?: OAuthRequestToken };

  if (!result.Item) {
    return {
      success: false,
      avatarId: '',
      error: 'OAuth session expired or not found. Please try again.',
    };
  }

  const requestToken = result.Item as OAuthRequestToken;
  const { avatarId, oauthTokenSecret } = requestToken;

  // Clean up the request token
  await deps.dynamoClient.send(new DeleteCommand({
    TableName: deps.tableName,
    Key: {
      pk: `OAUTH#TWITTER#${oauthToken}`,
      sk: 'OAUTH_REQUEST',
    },
  }));

  try {
    // Exchange for access token
    const client = new deps.TwitterApi({
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      accessToken: oauthToken,
      accessSecret: oauthTokenSecret,
    });

    // login() returns screenName and userId from the OAuth response itself
    // This avoids hitting the v2.me() endpoint which has stricter rate limits
    const { accessToken, accessSecret, screenName, userId } = await client.login(oauthVerifier);

    // Use screenName from OAuth response (avoids rate-limited v2.me() call)
    const username = screenName;

    // Fetch verified_type to determine character limit for premium accounts
    // Premium/Blue users can post up to 10,000 characters vs 280 for free accounts
    let verifiedType: string | undefined;
    let charLimit = 280; // Default for free accounts
    try {
      const loggedInClient = new deps.TwitterApi({
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        accessToken,
        accessSecret,
      });
      const meResponse = await loggedInClient.v2.me({ 'user.fields': ['verified_type'] });
      verifiedType = meResponse.data.verified_type;
      // Twitter Blue/Premium users get 10,000 character limit
      if (verifiedType === 'blue' || verifiedType === 'business') {
        charLimit = 10000;
      }
      console.log(`[TwitterOAuth] User @${username} verified_type=${verifiedType}, charLimit=${charLimit}`);
    } catch (verifyError) {
      // Non-fatal: continue with default 280 limit if we can't fetch verified_type
      console.warn(`[TwitterOAuth] Could not fetch verified_type for @${username}:`, verifyError);
    }

    // Store the access tokens in Secrets Manager
    await deps.secretsService.storeSecret(
      avatarId,
      'twitter_access_token',
      'default',
      accessToken,
      session,
      `Twitter access token for @${username}`
    );

    await deps.secretsService.storeSecret(
      avatarId,
      'twitter_access_secret',
      'default',
      accessSecret,
      session,
      `Twitter access secret for @${username}`
    );

    // Store a metadata record for quick lookup
    await deps.dynamoClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: `AVATAR#${avatarId}`,
        sk: 'TWITTER#CONNECTION',
        username,
        userId,
        verifiedType,
        charLimit,
        connectedAt: Date.now(),
        connectedBy: session.email,
      },
    }));

    console.log(JSON.stringify({
      level: 'INFO',
      subsystem: 'twitter-oauth',
      event: 'oauth_completed',
      avatarId,
      username,
      userId,
    }));

    return {
      success: true,
      avatarId,
      username,
      userId,
    };
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'twitter-oauth',
      event: 'oauth_failed',
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    }));

    return {
      success: false,
      avatarId,
      error: error instanceof Error ? error.message : 'Failed to complete OAuth flow',
    };
  }
}

/**
 * Get the Twitter connection status for an avatar
 *
 * Checks DynamoDB metadata record first, then falls back to checking
 * Secrets Manager for tokens. This handles cases where the DynamoDB
 * record may be missing but tokens exist (e.g., failed DynamoDB write
 * after successful token storage).
 */
export async function getConnectionStatus(avatarId: string, deps: TwitterOAuthServiceDeps = defaultDeps): Promise<{
  connected: boolean;
  username?: string;
  userId?: string;
  verifiedType?: string;
  charLimit?: number;
  connectedAt?: number;
}> {
  // First check DynamoDB metadata record (use consistent read to avoid stale data after reconnect)
  const result = await deps.dynamoClient.send(new GetCommand({
    TableName: deps.tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'TWITTER#CONNECTION',
    },
    ConsistentRead: true,
  })) as { Item?: { username?: string; userId?: string; verifiedType?: string; charLimit?: number; connectedAt?: number } };

  if (result.Item) {
    return {
      connected: true,
      username: result.Item.username,
      userId: result.Item.userId,
      verifiedType: result.Item.verifiedType,
      charLimit: result.Item.charLimit ?? 280, // Default to 280 for legacy records
      connectedAt: result.Item.connectedAt,
    };
  }

  // Fallback: Check if tokens exist in Secrets Manager
  // This handles the case where DynamoDB write failed but tokens were stored
  try {
    const accessToken = await deps.secretsService.getSecretValue(avatarId, 'twitter_access_token', 'default');
    const accessSecret = await deps.secretsService.getSecretValue(avatarId, 'twitter_access_secret', 'default');

    if (accessToken && accessSecret) {
      console.log(JSON.stringify({
        level: 'WARN',
        subsystem: 'twitter-oauth',
        event: 'connection_record_missing_but_tokens_exist',
        avatarId,
        message: 'DynamoDB metadata missing but tokens found in Secrets Manager',
      }));

      // Tokens exist - try to verify and repair the metadata record
      const creds = await getAppCredentials(deps);
      if (creds) {
        try {
          const client = new deps.TwitterApi({
            appKey: creds.appKey,
            appSecret: creds.appSecret,
            accessToken,
            accessSecret,
          });

          // Verify tokens by fetching user info including verified_type
          const me = await client.v2.me({ 'user.fields': ['verified_type'] });
          const username = me.data.username;
          const userId = me.data.id;
          const verifiedType = me.data.verified_type;
          const charLimit = (verifiedType === 'blue' || verifiedType === 'business') ? 10000 : 280;

          // Repair the metadata record
          await deps.dynamoClient.send(new PutCommand({
            TableName: deps.tableName,
            Item: {
              pk: `AVATAR#${avatarId}`,
              sk: 'TWITTER#CONNECTION',
              username,
              userId,
              verifiedType,
              charLimit,
              connectedAt: Date.now(),
              repairedAt: Date.now(),
            },
          }));

          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'twitter-oauth',
            event: 'connection_record_repaired',
            avatarId,
            username,
            userId,
            verifiedType,
            charLimit,
          }));

          return {
            connected: true,
            username,
            userId,
            verifiedType,
            charLimit,
            connectedAt: Date.now(),
          };
        } catch (verifyError) {
          // Tokens exist but are invalid - still report as connected
          // Let the actual posting operation handle the invalid token error
          console.log(JSON.stringify({
            level: 'WARN',
            subsystem: 'twitter-oauth',
            event: 'token_verification_failed',
            avatarId,
            error: verifyError instanceof Error ? verifyError.message : String(verifyError),
          }));

          return {
            connected: true,
            // No username/userId since we couldn't verify
          };
        }
      }

      // App credentials not available, but user tokens exist
      return { connected: true };
    }
  } catch {
    // Secrets not found - truly not connected
  }

  return { connected: false };
}

/**
 * Disconnect Twitter from an avatar (remove tokens)
 */
export async function disconnectTwitter(
  avatarId: string,
  session: UserSession,
  deps: TwitterOAuthServiceDeps = defaultDeps
): Promise<void> {
  // Delete the access tokens from Secrets Manager
  // Use forceDelete=true because OAuth tokens can be re-authorized,
  // and scheduled deletion would block storing new tokens
  try {
    await deps.secretsService.deleteSecret(avatarId, 'twitter_access_token', 'default', session, true);
  } catch {
    // Ignore if not found
  }

  try {
    await deps.secretsService.deleteSecret(avatarId, 'twitter_access_secret', 'default', session, true);
  } catch {
    // Ignore if not found
  }

  // Delete the connection record
  await deps.dynamoClient.send(new DeleteCommand({
    TableName: deps.tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'TWITTER#CONNECTION',
    },
  }));

  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'twitter-oauth',
    event: 'twitter_disconnected',
    avatarId,
    by: session.email,
  }));
}

/**
 * Get credentials for an avatar (used by handlers that need to post)
 * Returns the app + user credentials needed to create a TwitterApi client
 */
export async function getAvatarTwitterCredentials(avatarId: string, deps: TwitterOAuthServiceDeps = defaultDeps): Promise<{
  configured: boolean;
  appKey?: string;
  appSecret?: string;
  accessToken?: string;
  accessSecret?: string;
}> {
  const creds = await getAppCredentials(deps);
  if (!creds) {
    return { configured: false };
  }

  // Check if avatar has connected Twitter
  const status = await getConnectionStatus(avatarId, deps);
  if (!status.connected) {
    return { configured: false };
  }

  // Get the access tokens from Secrets Manager
  try {
    const accessToken = await deps.secretsService.getSecretValue(avatarId, 'twitter_access_token', 'default');
    const accessSecret = await deps.secretsService.getSecretValue(avatarId, 'twitter_access_secret', 'default');

    if (!accessToken || !accessSecret) {
      return { configured: false };
    }

    return {
      configured: true,
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      accessToken,
      accessSecret,
    };
  } catch (error) {
    // Don't log the full error object as it may contain sensitive credentials
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to get Twitter credentials: ${errorMessage}`);
    return { configured: false };
  }
}
