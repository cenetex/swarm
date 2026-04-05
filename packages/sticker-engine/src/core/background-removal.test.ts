/**
 * Tests for background removal algorithm
 *
 * Tests color analysis utilities and edge flood-fill algorithm
 */

import { describe, it, expect } from 'bun:test';
import { rgbChroma, isGrayish, luma } from './background-removal.js';

describe('Color Analysis Utilities', () => {
  describe('rgbChroma', () => {
    it('calculates chroma (color intensity) correctly', () => {
      // Pure red
      expect(rgbChroma(255, 0, 0)).toBe(255);
      // Pure green
      expect(rgbChroma(0, 255, 0)).toBe(255);
      // Pure blue
      expect(rgbChroma(0, 0, 255)).toBe(255);
      // Pure white/gray
      expect(rgbChroma(128, 128, 128)).toBe(0);
      // Mixed color
      expect(rgbChroma(200, 100, 50)).toBe(150); // max(200,100,50) - min(200,100,50) = 200 - 50
    });
  });

  describe('isGrayish', () => {
    it('detects gray-ish colors within variance', () => {
      // True gray
      expect(isGrayish(128, 128, 128)).toBe(true);
      // Close to gray (default variance = 18)
      expect(isGrayish(128, 130, 132)).toBe(true);
      // Outside variance
      expect(isGrayish(128, 150, 160)).toBe(false);
      // Custom variance
      expect(isGrayish(128, 140, 150, 30)).toBe(true);
    });
  });

  describe('luma', () => {
    it('calculates luminance correctly (BT.709)', () => {
      // Black
      expect(luma(0, 0, 0)).toBe(0);
      // White
      expect(luma(255, 255, 255)).toBe(255);
      // Gray
      const grayLuma = luma(128, 128, 128);
      expect(grayLuma).toBeGreaterThan(100);
      expect(grayLuma).toBeLessThan(130);
      // Green has highest coefficient (0.7152)
      const greenLuma = luma(0, 255, 0);
      const redLuma = luma(255, 0, 0);
      expect(greenLuma).toBeGreaterThan(redLuma);
    });
  });
});
