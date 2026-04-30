import { describe, it, expect, beforeEach } from 'vitest';
import { TwitterSocialGraphService, scoreHeuristic, passesHeuristicThreshold } from './twitter-social-graph.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockDeep } from 'vitest-mock-extended';

describe('TwitterSocialGraphService', () => {
  let mockDocClient: DynamoDBDocumentClient;
  let service: TwitterSocialGraphService;

  beforeEach(() => {
    mockDocClient = mockDeep<DynamoDBDocumentClient>();
    service = new TwitterSocialGraphService(mockDocClient, 'test-table');
  });

  describe('scoreHeuristic', () => {
    it('scores established accounts with mutuals higher', () => {
      const score = scoreHeuristic({
        accountAge: 365,
        mutualCount: 100,
        verificationStatus: 'blue',
        hasCryptoTickers: false,
      });
      expect(score).toBeGreaterThan(0.7);
    });

    it('heavily penalizes crypto spam signals', () => {
      const score = scoreHeuristic({
        accountAge: 365,
        mutualCount: 100,
        hasCryptoTickers: true,
      });
      expect(score).toBeLessThan(0.6);
    });

    it('scores new accounts lower', () => {
      const score = scoreHeuristic({
        accountAge: 7,
        mutualCount: 5,
      });
      expect(score).toBeLessThan(0.5);
    });
  });

  describe('passesHeuristicThreshold', () => {
    it('returns true for scores above threshold', () => {
      expect(passesHeuristicThreshold(0.65, 0.6)).toBe(true);
    });

    it('returns false for scores below threshold', () => {
      expect(passesHeuristicThreshold(0.55, 0.6)).toBe(false);
    });

    it('uses default threshold of 0.6', () => {
      expect(passesHeuristicThreshold(0.6)).toBe(true);
      expect(passesHeuristicThreshold(0.59)).toBe(false);
    });
  });
});
