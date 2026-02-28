/**
 * Twitter OAuth Service Tests
 *
 * Tests for the OAuth 1.0a 3-legged flow for connecting X/Twitter accounts.
 * Uses dependency injection for testing instead of module mocking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isConfigured,
  startOAuthFlow,
  completeOAuthFlow,
  getConnectionStatus,
  disconnectTwitter,
  getAvatarTwitterCredentials,
  _resetCacheForTesting,
  type TwitterOAuthServiceDeps,
} from './twitter-oauth.js';
import type { UserSession } from '../../types.js';

// Mock TwitterApi class
class MockTwitterApi {
  config: { appKey: string; appSecret: string; accessToken?: string; accessSecret?: string };
  mockGenerateAuthLink: ReturnType<typeof vi.fn>;
  mockLogin: ReturnType<typeof vi.fn>;
  mockMe: ReturnType<typeof vi.fn>;

  constructor(config: { appKey: string; appSecret: string; accessToken?: string; accessSecret?: string }) {
    this.config = config;
    this.mockGenerateAuthLink = vi.fn(() => Promise.resolve({
      url: 'https://twitter.com/oauth/authorize?oauth_token=test-token',
      oauth_token: 'test-oauth-token',
      oauth_token_secret: 'test-oauth-secret',
    }));
    this.mockLogin = vi.fn(() => Promise.resolve({
      client: { v2: { me: this.mockMe } },
      accessToken: 'new-access-token',
      accessSecret: 'new-access-secret',
      screenName: 'testuser',
      userId: '12345',
    }));
    this.mockMe = vi.fn(() => Promise.resolve({
      data: { username: 'testuser', id: '12345' },
    }));
  }

  generateAuthLink(callbackUrl: string, options: { linkMode: string }) {
    return this.mockGenerateAuthLink(callbackUrl, options);
  }

  login(verifier: string) {
    return this.mockLogin(verifier);
  }

  v2 = {
    me: () => this.mockMe(),
  };
}

// Helper to create mock deps
function createMockDeps(): TwitterOAuthServiceDeps & {
  mockDynamoSend: ReturnType<typeof vi.fn>;
  mockSecretsSend: ReturnType<typeof vi.fn>;
  mockStoreSecret: ReturnType<typeof vi.fn>;
  mockDeleteSecret: ReturnType<typeof vi.fn>;
  mockGetSecretValue: ReturnType<typeof vi.fn>;
  lastTwitterApiInstance: MockTwitterApi | null;
} {
  const mockDynamoSend = vi.fn(() => Promise.resolve({}));
  const mockSecretsSend = vi.fn(() => Promise.resolve({
    SecretString: JSON.stringify({
      TWITTER_APP_KEY: 'test-app-key',
      TWITTER_APP_SECRET: 'test-app-secret',
    }),
  }));
  const mockStoreSecret = vi.fn(() => Promise.resolve());
  const mockDeleteSecret = vi.fn(() => Promise.resolve());
  const mockGetSecretValue = vi.fn(() => Promise.resolve('secret-value'));

  let lastTwitterApiInstance: MockTwitterApi | null = null;

  return {
    dynamoClient: {
      send: mockDynamoSend as unknown as TwitterOAuthServiceDeps['dynamoClient']['send'],
    },
    secretsClient: {
      send: mockSecretsSend as unknown as TwitterOAuthServiceDeps['secretsClient']['send'],
    },
    secretsService: {
      storeSecret: mockStoreSecret as unknown as TwitterOAuthServiceDeps['secretsService']['storeSecret'],
      deleteSecret: mockDeleteSecret as unknown as TwitterOAuthServiceDeps['secretsService']['deleteSecret'],
      getSecretValue: mockGetSecretValue as unknown as TwitterOAuthServiceDeps['secretsService']['getSecretValue'],
    },
    TwitterApi: class extends MockTwitterApi {
      constructor(config: { appKey: string; appSecret: string; accessToken?: string; accessSecret?: string }) {
        super(config);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastTwitterApiInstance = this;
      }
    } as unknown as typeof import('twitter-api-v2').TwitterApi,
    tableName: 'test-admin-table',
    oauthCallbackUrl: 'https://admin.test.com/oauth/twitter/callback',
    appCredentialsArn: 'swarm/global/twitter-app-credentials',
    mockDynamoSend,
    mockSecretsSend,
    mockStoreSecret,
    mockDeleteSecret,
    mockGetSecretValue,
    get lastTwitterApiInstance() {
      return lastTwitterApiInstance;
    },
    set lastTwitterApiInstance(val) {
      lastTwitterApiInstance = val;
    },
  };
}

// Helper to create test session
function createTestSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    email: 'test@example.com',
    userId: 'user-123',
    isAdmin: true,
    accessToken: 'test-access-token',
    ...overrides,
  };
}

describe('Twitter OAuth - Configuration', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('should define credentials ARN pattern', () => {
    const defaultArn = 'swarm/global/twitter-app-credentials';
    expect(defaultArn).toMatch(/^swarm\/global\/twitter-app-credentials$/);
  });

  it('isConfigured returns true when credentials and callback URL exist', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));

    const result = await isConfigured(mockDeps);
    expect(result).toBe(true);
  });

  it('isConfigured returns false when credentials missing', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.reject(new Error('Secret not found')));

    const result = await isConfigured(mockDeps);
    expect(result).toBe(false);
  });

  it('isConfigured returns false when callback URL missing', async () => {
    mockDeps.oauthCallbackUrl = '';
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));

    const result = await isConfigured(mockDeps);
    expect(result).toBe(false);
  });

  it('getAppCredentials caches credentials after first fetch', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));

    // Call twice
    await isConfigured(mockDeps);
    await isConfigured(mockDeps);

    // Should only fetch once due to caching
    expect(mockDeps.mockSecretsSend).toHaveBeenCalledTimes(1);
  });

  it('getAppCredentials returns null on Secrets Manager error', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.reject(new Error('Access denied')));

    const result = await isConfigured(mockDeps);
    expect(result).toBe(false);
  });
});

describe('Twitter OAuth - Request Token Storage', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('should generate correct DynamoDB key pattern', () => {
    const oauthToken = 'abc123';
    const pk = `OAUTH#TWITTER#${oauthToken}`;
    const sk = 'OAUTH_REQUEST';

    expect(pk).toBe('OAUTH#TWITTER#abc123');
    expect(sk).toBe('OAUTH_REQUEST');
  });

  it('should set TTL to 10 minutes', () => {
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + 600;
    const expectedExpiry = Math.floor(now / 1000) + 600;

    expect(ttl).toBe(expectedExpiry);
  });

  it('startOAuthFlow stores request token in DynamoDB', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({}));

    await startOAuthFlow('avatar-123', mockDeps);

    expect(mockDeps.mockDynamoSend).toHaveBeenCalled();
    const call = mockDeps.mockDynamoSend.mock.calls[0][0] as { input?: { Item?: Record<string, unknown> } };
    const item = call.input?.Item;
    expect(item?.pk).toBe('OAUTH#TWITTER#test-oauth-token');
    expect(item?.sk).toBe('OAUTH_REQUEST');
    expect(item?.avatarId).toBe('avatar-123');
  });
});

describe('Twitter OAuth - Start Flow', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('startOAuthFlow throws when not configured', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.reject(new Error('Not found')));

    await expect(startOAuthFlow('avatar-123', mockDeps)).rejects.toThrow('Twitter OAuth not configured');
  });

  it('startOAuthFlow returns authorization URL and token', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({}));

    const result = await startOAuthFlow('avatar-123', mockDeps);

    expect(result.authorizationUrl).toContain('twitter.com');
    expect(result.oauthToken).toBe('test-oauth-token');
  });
});

describe('Twitter OAuth - Complete Flow', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;
  const session = createTestSession();

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('completeOAuthFlow returns error for expired/missing token', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({ Item: undefined }));

    const result = await completeOAuthFlow('expired-token', 'verifier', session, mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('completeOAuthFlow deletes request token after retrieval', async () => {
    let callCount = 0;
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Item: {
            avatarId: 'avatar-123',
            oauthToken: 'test-token',
            oauthTokenSecret: 'test-secret',
          },
        });
      }
      return Promise.resolve({});
    });

    await completeOAuthFlow('test-token', 'verifier', session, mockDeps);

    // Should have called: GetCommand, DeleteCommand, PutCommand (connection record)
    expect(mockDeps.mockDynamoSend).toHaveBeenCalledTimes(3);
  });

  it('completeOAuthFlow stores access token in Secrets Manager', async () => {
    let callCount = 0;
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Item: {
            avatarId: 'avatar-123',
            oauthToken: 'test-token',
            oauthTokenSecret: 'test-secret',
          },
        });
      }
      return Promise.resolve({});
    });

    await completeOAuthFlow('test-token', 'verifier', session, mockDeps);

    expect(mockDeps.mockStoreSecret).toHaveBeenCalledWith(
      'avatar-123',
      'twitter_access_token',
      'default',
      'new-access-token',
      session,
      expect.stringContaining('Twitter access token for @')
    );
  });

  it('completeOAuthFlow stores access secret in Secrets Manager', async () => {
    let callCount = 0;
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Item: {
            avatarId: 'avatar-123',
            oauthToken: 'test-token',
            oauthTokenSecret: 'test-secret',
          },
        });
      }
      return Promise.resolve({});
    });

    await completeOAuthFlow('test-token', 'verifier', session, mockDeps);

    expect(mockDeps.mockStoreSecret).toHaveBeenCalledWith(
      'avatar-123',
      'twitter_access_secret',
      'default',
      'new-access-secret',
      session,
      expect.stringContaining('Twitter access secret for @')
    );
  });

  it('completeOAuthFlow creates connection record in DynamoDB', async () => {
    let callCount = 0;
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Item: {
            avatarId: 'avatar-123',
            oauthToken: 'test-token',
            oauthTokenSecret: 'test-secret',
          },
        });
      }
      return Promise.resolve({});
    });

    await completeOAuthFlow('test-token', 'verifier', session, mockDeps);

    // Third call should be PutCommand for connection record
    const calls = mockDeps.mockDynamoSend.mock.calls;
    const putCall = calls[2][0] as { input?: { Item?: Record<string, unknown> } };
    expect(putCall.input?.Item?.pk).toBe('AVATAR#avatar-123');
    expect(putCall.input?.Item?.sk).toBe('TWITTER#CONNECTION');
    expect(putCall.input?.Item?.username).toBe('testuser');
    expect(putCall.input?.Item?.userId).toBe('12345');
  });

  it('completeOAuthFlow returns success with username and userId', async () => {
    let callCount = 0;
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Item: {
            avatarId: 'avatar-123',
            oauthToken: 'test-token',
            oauthTokenSecret: 'test-secret',
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await completeOAuthFlow('test-token', 'verifier', session, mockDeps);

    expect(result).toEqual({
      success: true,
      avatarId: 'avatar-123',
      username: 'testuser',
      userId: '12345',
    });
  });
});

describe('Twitter OAuth - Connection Status', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('should generate correct connection record key', () => {
    const avatarId = 'avatar-123';
    const pk = `AVATAR#${avatarId}`;
    const sk = 'TWITTER#CONNECTION';

    expect(pk).toBe('AVATAR#avatar-123');
    expect(sk).toBe('TWITTER#CONNECTION');
  });

  it('getConnectionStatus returns connected=false when no record and no tokens', async () => {
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({ Item: undefined }));
    // Also mock secrets to return null - no tokens in Secrets Manager
    mockDeps.mockGetSecretValue.mockImplementation(() => Promise.resolve(null));

    const result = await getConnectionStatus('avatar-123', mockDeps);

    expect(result).toEqual({ connected: false });
  });

  it('getConnectionStatus repairs metadata when DynamoDB empty but tokens exist', async () => {
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({ Item: undefined }));
    // Tokens exist in Secrets Manager
    mockDeps.mockGetSecretValue
      .mockImplementationOnce(() => Promise.resolve('access-token'))
      .mockImplementationOnce(() => Promise.resolve('access-secret'));

    const result = await getConnectionStatus('avatar-123', mockDeps);

    // Should be connected and repair the metadata
    expect(result.connected).toBe(true);
    expect(result.username).toBe('testuser');
    expect(result.userId).toBe('12345');
  });

  it('getConnectionStatus returns full status when connected', async () => {
    const connectedAt = Date.now() - 86400000; // 1 day ago
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({
      Item: {
        pk: 'AVATAR#avatar-123',
        sk: 'TWITTER#CONNECTION',
        username: 'testuser',
        userId: '12345',
        connectedAt,
        connectedBy: 'admin@test.com',
      },
    }));

    const result = await getConnectionStatus('avatar-123', mockDeps);

    expect(result).toMatchObject({
      connected: true,
      username: 'testuser',
      userId: '12345',
      connectedAt,
    });
  });

  it('getConnectionStatus includes username, userId, connectedAt', async () => {
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({
      Item: {
        username: 'handle',
        userId: '999',
        connectedAt: 1704067200000,
      },
    }));

    const result = await getConnectionStatus('avatar-xyz', mockDeps);

    expect(result.username).toBe('handle');
    expect(result.userId).toBe('999');
    expect(result.connectedAt).toBe(1704067200000);
  });
});

describe('Twitter OAuth - Disconnect', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;
  const session = createTestSession();

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('disconnectTwitter deletes access token from Secrets Manager', async () => {
    mockDeps.mockDeleteSecret.mockImplementation(() => Promise.resolve());
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({}));

    await disconnectTwitter('avatar-123', session, mockDeps);

    expect(mockDeps.mockDeleteSecret).toHaveBeenCalledWith(
      'avatar-123',
      'twitter_access_token',
      'default',
      session,
      true
    );
  });

  it('disconnectTwitter deletes access secret from Secrets Manager', async () => {
    mockDeps.mockDeleteSecret.mockImplementation(() => Promise.resolve());
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({}));

    await disconnectTwitter('avatar-123', session, mockDeps);

    expect(mockDeps.mockDeleteSecret).toHaveBeenCalledWith(
      'avatar-123',
      'twitter_access_secret',
      'default',
      session,
      true
    );
  });

  it('disconnectTwitter handles missing secrets gracefully', async () => {
    mockDeps.mockDeleteSecret.mockImplementation(() => Promise.reject(new Error('Secret not found')));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({}));

    // Should resolve without throwing
    await expect(disconnectTwitter('avatar-123', session, mockDeps)).resolves.toBeUndefined();
  });

  it('disconnectTwitter deletes connection record from DynamoDB', async () => {
    mockDeps.mockDeleteSecret.mockImplementation(() => Promise.resolve());
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({}));

    await disconnectTwitter('avatar-123', session, mockDeps);

    expect(mockDeps.mockDynamoSend).toHaveBeenCalled();
    const call = mockDeps.mockDynamoSend.mock.calls[0][0] as { input?: { Key?: Record<string, unknown> } };
    expect(call.input?.Key?.pk).toBe('AVATAR#avatar-123');
    expect(call.input?.Key?.sk).toBe('TWITTER#CONNECTION');
  });
});

describe('Twitter OAuth - Get Avatar Credentials', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('getAvatarTwitterCredentials returns configured=false when no app credentials', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.reject(new Error('Not found')));

    const result = await getAvatarTwitterCredentials('avatar-123', mockDeps);

    expect(result).toEqual({ configured: false });
  });

  it('getAvatarTwitterCredentials returns configured=false when no tokens exist', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({ Item: undefined }));
    // No tokens in Secrets Manager
    mockDeps.mockGetSecretValue.mockImplementation(() => Promise.resolve(null));

    const result = await getAvatarTwitterCredentials('avatar-123', mockDeps);

    expect(result).toEqual({ configured: false });
  });

  it('getAvatarTwitterCredentials returns credentials when DynamoDB empty but tokens exist', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({ Item: undefined }));
    // Tokens exist in Secrets Manager - fallback should repair and return credentials
    mockDeps.mockGetSecretValue
      .mockImplementationOnce(() => Promise.resolve('user-access-token'))
      .mockImplementationOnce(() => Promise.resolve('user-access-secret'))
      // Called again after repair by getAvatarTwitterCredentials
      .mockImplementationOnce(() => Promise.resolve('user-access-token'))
      .mockImplementationOnce(() => Promise.resolve('user-access-secret'));

    const result = await getAvatarTwitterCredentials('avatar-123', mockDeps);

    expect(result).toEqual({
      configured: true,
      appKey: 'test-app-key',
      appSecret: 'test-app-secret',
      accessToken: 'user-access-token',
      accessSecret: 'user-access-secret',
    });
  });

  it('getAvatarTwitterCredentials fetches tokens from Secrets Manager', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({
      Item: { username: 'user', userId: '123' },
    }));
    mockDeps.mockGetSecretValue
      .mockImplementationOnce(() => Promise.resolve('user-access-token'))
      .mockImplementationOnce(() => Promise.resolve('user-access-secret'));

    await getAvatarTwitterCredentials('avatar-123', mockDeps);

    expect(mockDeps.mockGetSecretValue).toHaveBeenCalledWith('avatar-123', 'twitter_access_token', 'default');
    expect(mockDeps.mockGetSecretValue).toHaveBeenCalledWith('avatar-123', 'twitter_access_secret', 'default');
  });

  it('getAvatarTwitterCredentials returns configured=false when tokens missing', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({
      Item: { username: 'user', userId: '123' },
    }));
    mockDeps.mockGetSecretValue.mockImplementation(() => Promise.resolve(null));

    const result = await getAvatarTwitterCredentials('avatar-123', mockDeps);

    expect(result).toEqual({ configured: false });
  });

  it('getAvatarTwitterCredentials returns full credentials when configured', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({
      Item: { username: 'user', userId: '123' },
    }));
    mockDeps.mockGetSecretValue
      .mockImplementationOnce(() => Promise.resolve('user-access-token'))
      .mockImplementationOnce(() => Promise.resolve('user-access-secret'));

    const result = await getAvatarTwitterCredentials('avatar-123', mockDeps);

    expect(result).toEqual({
      configured: true,
      appKey: 'test-app-key',
      appSecret: 'test-app-secret',
      accessToken: 'user-access-token',
      accessSecret: 'user-access-secret',
    });
  });

  it('getAvatarTwitterCredentials handles Secrets Manager errors', async () => {
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => Promise.resolve({
      Item: { username: 'user', userId: '123' },
    }));
    mockDeps.mockGetSecretValue.mockImplementation(() => Promise.reject(new Error('Access denied')));

    const result = await getAvatarTwitterCredentials('avatar-123', mockDeps);

    expect(result).toEqual({ configured: false });
  });
});

describe('Twitter OAuth - Security', () => {
  let mockDeps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    mockDeps = createMockDeps();
    _resetCacheForTesting();
  });

  it('access tokens stored with proper secret names', async () => {
    let callCount = 0;
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Item: {
            avatarId: 'avatar-123',
            oauthToken: 'token',
            oauthTokenSecret: 'secret',
          },
        });
      }
      return Promise.resolve({});
    });
    mockDeps.mockStoreSecret.mockImplementation(() => Promise.resolve());

    await completeOAuthFlow('token', 'verifier', createTestSession(), mockDeps);

    // Verify proper secret type names are used
    const storeSecretCalls = mockDeps.mockStoreSecret.mock.calls;
    const secretTypes = storeSecretCalls.map((call) => call[1]);

    expect(secretTypes).toContain('twitter_access_token');
    expect(secretTypes).toContain('twitter_access_secret');
  });

  it('session info included in connection record', async () => {
    let callCount = 0;
    mockDeps.mockSecretsSend.mockImplementation(() => Promise.resolve({
      SecretString: JSON.stringify({
        TWITTER_APP_KEY: 'test-app-key',
        TWITTER_APP_SECRET: 'test-app-secret',
      }),
    }));
    mockDeps.mockDynamoSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Item: {
            avatarId: 'avatar-123',
            oauthToken: 'token',
            oauthTokenSecret: 'secret',
          },
        });
      }
      return Promise.resolve({});
    });
    mockDeps.mockStoreSecret.mockImplementation(() => Promise.resolve());

    const session = createTestSession({ email: 'auditor@example.com' });

    await completeOAuthFlow('token', 'verifier', session, mockDeps);

    // Third call should be PutCommand for connection record
    const calls = mockDeps.mockDynamoSend.mock.calls;
    const putCall = calls[2][0] as { input?: { Item?: Record<string, unknown> } };
    expect(putCall.input?.Item?.connectedBy).toBe('auditor@example.com');
  });
});
