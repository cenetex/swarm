/**
 * Twitter OAuth 1.0a Service
 * Handles 3-legged OAuth flow for connecting X/Twitter accounts to agents
 * 
 * Flow:
 * 1. User clicks "Connect X Account" → /oauth/twitter/start?agentId=xxx
 * 2. We get request token from Twitter, store it, redirect user to Twitter
 * 3. User authorizes on Twitter → redirected back to /oauth/twitter/callback
 * 4. We exchange request token for access token, store in Secrets Manager
 */
import { TwitterApi } from 'twitter-api-v2';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import * as secretsService from './secrets.js';
import type { UserSession } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const OAUTH_CALLBACK_URL = process.env.TWITTER_OAUTH_CALLBACK_URL || '';

// ARN for Twitter app credentials secret
const TWITTER_APP_CREDENTIALS_ARN = process.env.TWITTER_APP_CREDENTIALS_ARN || 'swarm/global/twitter-app-credentials';

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
async function getAppCredentials(): Promise<{ appKey: string; appSecret: string } | null> {
  if (cachedAppCredentials) {
    return cachedAppCredentials;
  }

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: TWITTER_APP_CREDENTIALS_ARN,
    }));

    if (!response.SecretString) {
      return null;
    }

    const parsed = JSON.parse(response.SecretString);
    cachedAppCredentials = {
      appKey: parsed.TWITTER_APP_KEY,
      appSecret: parsed.TWITTER_APP_SECRET,
    };
    return cachedAppCredentials;
  } catch (error) {
    console.error('Failed to get Twitter app credentials:', error);
    return null;
  }
}

interface OAuthRequestToken {
  pk: string;           // OAUTH#TWITTER#<oauth_token>
  sk: string;           // OAUTH_REQUEST
  agentId: string;
  oauthToken: string;
  oauthTokenSecret: string;
  createdAt: number;
  ttl: number;          // Expire after 10 minutes
}

/**
 * Check if Twitter OAuth is configured
 */
export async function isConfigured(): Promise<boolean> {
  const creds = await getAppCredentials();
  return !!(creds?.appKey && creds?.appSecret && OAUTH_CALLBACK_URL);
}

/**
 * Start the OAuth flow - get request token and return authorization URL
 */
export async function startOAuthFlow(agentId: string): Promise<{
  authorizationUrl: string;
  oauthToken: string;
}> {
  const creds = await getAppCredentials();
  if (!creds || !OAUTH_CALLBACK_URL) {
    throw new Error('Twitter OAuth not configured. Ensure swarm/global/twitter-app-credentials secret exists and TWITTER_OAUTH_CALLBACK_URL is set.');
  }

  // Create a client for getting request token
  const client = new TwitterApi({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
  });

  // Get request token with callback URL that includes state
  const { url, oauth_token, oauth_token_secret } = await client.generateAuthLink(
    OAUTH_CALLBACK_URL,
    { linkMode: 'authorize' } // 'authorize' asks every time, 'authenticate' auto-approves if already authorized
  );

  // Store the request token temporarily (needed to complete the flow)
  const now = Date.now();
  const record: OAuthRequestToken = {
    pk: `OAUTH#TWITTER#${oauth_token}`,
    sk: 'OAUTH_REQUEST',
    agentId,
    oauthToken: oauth_token,
    oauthTokenSecret: oauth_token_secret,
    createdAt: now,
    ttl: Math.floor(now / 1000) + 600, // Expire in 10 minutes
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: record,
  }));

  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'twitter-oauth',
    event: 'oauth_flow_started',
    agentId,
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
  session: UserSession
): Promise<{
  success: boolean;
  agentId: string;
  username?: string;
  userId?: string;
  error?: string;
}> {
  const creds = await getAppCredentials();
  if (!creds) {
    throw new Error('Twitter OAuth not configured');
  }

  // Retrieve the stored request token
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `OAUTH#TWITTER#${oauthToken}`,
      sk: 'OAUTH_REQUEST',
    },
  }));

  if (!result.Item) {
    return {
      success: false,
      agentId: '',
      error: 'OAuth session expired or not found. Please try again.',
    };
  }

  const requestToken = result.Item as OAuthRequestToken;
  const { agentId, oauthTokenSecret } = requestToken;

  // Clean up the request token
  await dynamoClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `OAUTH#TWITTER#${oauthToken}`,
      sk: 'OAUTH_REQUEST',
    },
  }));

  try {
    // Exchange for access token
    const client = new TwitterApi({
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      accessToken: oauthToken,
      accessSecret: oauthTokenSecret,
    });

    const { client: loggedClient, accessToken, accessSecret } = await client.login(oauthVerifier);

    // Get user info to verify and store username
    const me = await loggedClient.v2.me();
    const username = me.data.username;
    const userId = me.data.id;

    // Store the access tokens in Secrets Manager
    await secretsService.storeSecret(
      agentId,
      'twitter_access_token',
      'default',
      accessToken,
      session,
      `Twitter access token for @${username}`
    );

    await secretsService.storeSecret(
      agentId,
      'twitter_access_secret',
      'default',
      accessSecret,
      session,
      `Twitter access secret for @${username}`
    );

    // Store a metadata record for quick lookup
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: `AGENT#${agentId}`,
        sk: 'TWITTER#CONNECTION',
        username,
        userId,
        connectedAt: Date.now(),
        connectedBy: session.email,
      },
    }));

    console.log(JSON.stringify({
      level: 'INFO',
      subsystem: 'twitter-oauth',
      event: 'oauth_completed',
      agentId,
      username,
      userId,
    }));

    return {
      success: true,
      agentId,
      username,
      userId,
    };
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'twitter-oauth',
      event: 'oauth_failed',
      agentId,
      error: error instanceof Error ? error.message : String(error),
    }));

    return {
      success: false,
      agentId,
      error: error instanceof Error ? error.message : 'Failed to complete OAuth flow',
    };
  }
}

/**
 * Get the Twitter connection status for an agent
 */
export async function getConnectionStatus(agentId: string): Promise<{
  connected: boolean;
  username?: string;
  userId?: string;
  connectedAt?: number;
}> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'TWITTER#CONNECTION',
    },
  }));

  if (!result.Item) {
    return { connected: false };
  }

  return {
    connected: true,
    username: result.Item.username,
    userId: result.Item.userId,
    connectedAt: result.Item.connectedAt,
  };
}

/**
 * Disconnect Twitter from an agent (remove tokens)
 */
export async function disconnectTwitter(
  agentId: string,
  session: UserSession
): Promise<void> {
  // Delete the access tokens from Secrets Manager
  try {
    await secretsService.deleteSecret(agentId, 'twitter_access_token', 'default', session);
  } catch {
    // Ignore if not found
  }
  
  try {
    await secretsService.deleteSecret(agentId, 'twitter_access_secret', 'default', session);
  } catch {
    // Ignore if not found
  }

  // Delete the connection record
  await dynamoClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'TWITTER#CONNECTION',
    },
  }));

  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'twitter-oauth',
    event: 'twitter_disconnected',
    agentId,
    by: session.email,
  }));
}

/**
 * Get credentials for an agent (used by handlers that need to post)
 * Returns the app + user credentials needed to create a TwitterApi client
 */
export async function getAgentTwitterCredentials(agentId: string): Promise<{
  configured: boolean;
  appKey?: string;
  appSecret?: string;
  accessToken?: string;
  accessSecret?: string;
}> {
  const creds = await getAppCredentials();
  if (!creds) {
    return { configured: false };
  }

  // Check if agent has connected Twitter
  const status = await getConnectionStatus(agentId);
  if (!status.connected) {
    return { configured: false };
  }

  // Get the access tokens from Secrets Manager
  try {
    const accessToken = await secretsService.getSecretValue(agentId, 'twitter_access_token', 'default');
    const accessSecret = await secretsService.getSecretValue(agentId, 'twitter_access_secret', 'default');

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
    console.error('Failed to get Twitter credentials:', error);
    return { configured: false };
  }
}
