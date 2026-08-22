/**
 * Audio Transcription Handler
 * Transcribes audio files using OpenAI Whisper API
 */
import type {
  HttpRequest,
  HttpResponse,
} from "@swarm/core";
import { GetSecretValueCommand } from '@swarm/core';
import { getSecretsClient } from '../services/aws-clients.js';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';
import { logger } from '@swarm/core';
import { getCorsHeaders } from '../http/cors.js';
import { isAuthError } from '../auth/errors.js';

const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';

// Cache the API key after first fetch
let cachedApiKey: string | null = null;

async function getOpenAiApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  
  if (!LLM_API_KEY_SECRET_ARN) {
    throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  }

  const client = getSecretsClient();
  const response = await client.send(new GetSecretValueCommand({
    SecretId: LLM_API_KEY_SECRET_ARN,
  }));

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  try {
    const parsed = JSON.parse(response.SecretString);
    cachedApiKey = parsed.api_key || parsed.apiKey || parsed.API_KEY;
    if (!cachedApiKey) {
      throw new Error('api_key not found in secret');
    }
  } catch {
    if (response.SecretString.startsWith('sk-')) {
      cachedApiKey = response.SecretString;
    } else {
      throw new Error('Invalid API key format');
    }
  }

  return cachedApiKey!;
}
export async function handler(
  event: HttpRequest
): Promise<HttpResponse> {
  const corsHeaders = getCorsHeaders(event);

  // Handle CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate request
    const session = await authenticateRequest(event);
    if (!requireAdmin(session)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Only accept POST
    if (event.requestContext.http.method !== 'POST') {
      return {
        statusCode: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse multipart form data
    const contentType = event.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Expected multipart/form-data' }),
      };
    }

    // Extract boundary from content-type
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing boundary in content-type' }),
      };
    }

    const boundary = boundaryMatch[1];
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '');

    // Simple multipart parser
    const parts = parseMultipart(body, boundary);
    const audioPart = parts.find(p => p.name === 'audio');
    
    if (!audioPart || !audioPart.data) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No audio file provided' }),
      };
    }

    // Get API key
    const apiKey = await getOpenAiApiKey();

    // Create form data for OpenAI
    const formData = new FormData();
    const blob = new Blob([audioPart.data], { 
      type: audioPart.contentType || 'audio/webm' 
    });
    formData.append('file', blob, audioPart.filename || 'audio.webm');
    formData.append('model', WHISPER_MODEL);

    // Call OpenAI Whisper API
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('OpenAI transcription failed', undefined, { 
        status: response.status, 
        error: errorText 
      });
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Transcription failed' }),
      };
    }

    const result = await response.json() as { text: string; language?: string };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: result.text,
        language: result.language,
      }),
    };
  } catch (error) {
    if (isAuthError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    logger.error('Transcription handler error', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

interface MultipartPart {
  name?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundary = Buffer.from(`--${boundary}--`);
  
  let start = 0;
  let pos = 0;
  
  while (pos < body.length) {
    // Find next boundary
    const boundaryPos = body.indexOf(boundaryBuffer, pos);
    if (boundaryPos === -1) break;
    
    // Check if this is the end boundary
    if (body.slice(boundaryPos, boundaryPos + endBoundary.length).equals(endBoundary)) {
      // Process the part before the end boundary
      if (start > 0 && start < boundaryPos) {
        const partData = body.slice(start, boundaryPos - 2); // -2 for CRLF before boundary
        const part = parsePartData(partData);
        if (part) parts.push(part);
      }
      break;
    }
    
    // If we have a previous part, extract it
    if (start > 0) {
      const partData = body.slice(start, boundaryPos - 2); // -2 for CRLF before boundary
      const part = parsePartData(partData);
      if (part) parts.push(part);
    }
    
    // Move past boundary and CRLF
    pos = boundaryPos + boundaryBuffer.length + 2;
    start = pos;
  }
  
  return parts;
}

function parsePartData(data: Buffer): MultipartPart | null {
  // Find header/body separator (double CRLF)
  const headerEnd = data.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd === -1) return null;
  
  const headers = data.slice(0, headerEnd).toString('utf-8');
  const body = data.slice(headerEnd + 4);
  
  const part: MultipartPart = {};
  
  // Parse Content-Disposition
  const dispositionMatch = headers.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
  if (dispositionMatch) {
    part.name = dispositionMatch[1];
    part.filename = dispositionMatch[2];
  }
  
  // Parse Content-Type
  const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
  if (contentTypeMatch) {
    part.contentType = contentTypeMatch[1].trim();
  }
  
  part.data = body;
  
  return part;
}
