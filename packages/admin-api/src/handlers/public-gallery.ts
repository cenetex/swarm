/**
 * Public Gallery Handler
 * Serves gallery images at public URLs for Telegram and other platforms
 * 
 * Route: /gallery/{agentId}/{itemId}
 * Returns: 302 redirect to the actual image URL
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import * as gallery from '../services/gallery.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const agentId = event.pathParameters?.agentId;
  const itemId = event.pathParameters?.itemId;

  // CORS headers for public access
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
  };

  // Handle OPTIONS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (!agentId || !itemId) {
    return {
      statusCode: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing agentId or itemId' }),
    };
  }

  try {
    const item = await gallery.getGalleryItem(agentId, itemId);

    if (!item) {
      return {
        statusCode: 404,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Gallery item not found' }),
      };
    }

    // Redirect to the actual image URL
    // This allows Telegram and other services to fetch the image
    return {
      statusCode: 302,
      headers: {
        ...headers,
        'Location': item.url,
        'Content-Type': 'text/html',
      },
      body: `<html><head><meta http-equiv="refresh" content="0;url=${item.url}"></head><body>Redirecting to image...</body></html>`,
    };
  } catch (error) {
    console.error('Error fetching gallery item:', error);
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
