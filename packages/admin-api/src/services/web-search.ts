/**
 * Web search service for property research.
 */
import { GetSecretValueCommand } from '@swarm/core';
import { getSecretsClient } from './aws-clients.js';
import { logger } from '@swarm/core';

export type WebSearchFn = (query: string) => Promise<string>;

const SEARCH_PROVIDER = (process.env.WEB_SEARCH_PROVIDER || 'serpapi').toLowerCase();
const SEARCH_API_KEY_SECRET_ARN = process.env.WEB_SEARCH_API_KEY_SECRET_ARN;
const SEARCH_API_KEY = process.env.WEB_SEARCH_API_KEY;
const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 12_000);

let cachedApiKey: string | null = null;

async function getSearchApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  if (SEARCH_API_KEY) {
    cachedApiKey = SEARCH_API_KEY;
    return cachedApiKey;
  }

  if (!SEARCH_API_KEY_SECRET_ARN) {
    throw new Error('WEB_SEARCH_API_KEY_SECRET_ARN not configured');
  }

  const client = getSecretsClient();
  const response = await client.send(new GetSecretValueCommand({
    SecretId: SEARCH_API_KEY_SECRET_ARN,
  }));

  if (!response.SecretString) {
    throw new Error('Search API key secret is empty');
  }

  try {
    const parsed = JSON.parse(response.SecretString);
    cachedApiKey = parsed.api_key || parsed.apiKey || parsed.API_KEY || parsed.key;
  } catch {
    cachedApiKey = response.SecretString;
  }

  if (!cachedApiKey) {
    throw new Error('Search API key not found in secret');
  }

  return cachedApiKey;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function renderSerpApiResults(data: Record<string, unknown>): string {
  const lines: string[] = [];

  const answerBox = data.answer_box as Record<string, unknown> | undefined;
  if (answerBox?.answer) {
    lines.push(`Answer: ${answerBox.answer}`);
  }
  if (answerBox?.snippet) {
    lines.push(`Snippet: ${answerBox.snippet}`);
  }

  const knowledge = data.knowledge_graph as Record<string, unknown> | undefined;
  if (knowledge?.description) {
    lines.push(`Knowledge: ${knowledge.description}`);
  }

  const organic = data.organic_results as Array<Record<string, unknown>> | undefined;
  if (organic?.length) {
    for (const result of organic.slice(0, 10)) {
      if (result.title) lines.push(`Title: ${result.title}`);
      if (result.snippet) lines.push(`Snippet: ${result.snippet}`);
      if (result.link) lines.push(`Link: ${result.link}`);
      lines.push('');
    }
  }

  const localResults = data.local_results as Record<string, unknown> | undefined;
  const places = (localResults?.places as Array<Record<string, unknown>> | undefined) || [];
  if (places.length > 0) {
    lines.push('Local results:');
    for (const place of places.slice(0, 5)) {
      if (place.title) lines.push(`Place: ${place.title}`);
      if (place.address) lines.push(`Address: ${place.address}`);
      if (place.rating) lines.push(`Rating: ${place.rating}`);
      if (place.link) lines.push(`Link: ${place.link}`);
      lines.push('');
    }
  }

  return lines.join('\n').trim() || 'No results found';
}

async function serpApiSearch(query: string): Promise<string> {
  const apiKey = await getSearchApiKey();
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SerpAPI error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return renderSerpApiResults(data);
}

export function createWebSearch(): WebSearchFn {
  return async (query: string) => {
    switch (SEARCH_PROVIDER) {
      case 'serpapi':
        return serpApiSearch(query);
      case 'basic':
      case 'html':
        logger.warn('[WebSearch] HTML fallback is deprecated; configure SerpAPI for production.');
        return `Search provider not configured for: ${query}`;
      default:
        throw new Error(`Unsupported WEB_SEARCH_PROVIDER: ${SEARCH_PROVIDER}`);
    }
  };
}
