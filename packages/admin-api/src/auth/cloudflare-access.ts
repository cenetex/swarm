/**
 * Cloudflare Access Authentication
 * Verifies JWT tokens from Cloudflare Access
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CloudflareAccessClaims, UserSession } from '../types.js';

// Cloudflare Access public keys endpoint
const CF_ACCESS_CERTS_URL = process.env.CF_ACCESS_CERTS_URL;
const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN;
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD;

// Admin emails that have full access
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').filter(Boolean);

interface CloudflarePublicKey {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  e: string;
  n: string;
}

interface CloudflareKeysResponse {
  keys: CloudflarePublicKey[];
  public_cert: { kid: string; cert: string };
  public_certs: { kid: string; cert: string }[];
}

let cachedKeys: CloudflareKeysResponse | null = null;
let cacheExpiry = 0;

/**
 * Fetch Cloudflare Access public keys
 */
async function getPublicKeys(): Promise<CloudflareKeysResponse> {
  const now = Date.now();
  
  if (cachedKeys && now < cacheExpiry) {
    return cachedKeys;
  }

  const certsUrl = CF_ACCESS_CERTS_URL || 
    `https://${CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;

  const response = await fetch(certsUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Cloudflare Access keys: ${response.statusText}`);
  }

  cachedKeys = await response.json() as CloudflareKeysResponse;
  cacheExpiry = now + 3600000; // Cache for 1 hour

  return cachedKeys;
}

/**
 * Decode a JWT without verification (to get the header)
 */
function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
  const [headerB64] = token.split('.');
  if (!headerB64) throw new Error('Invalid JWT format');
  
  const headerJson = Buffer.from(headerB64, 'base64url').toString('utf-8');
  return JSON.parse(headerJson);
}

/**
 * Verify and decode a Cloudflare Access JWT
 */
async function verifyAccessToken(token: string): Promise<CloudflareAccessClaims> {
  // Get the key ID from the token header
  const header = decodeJwtHeader(token);
  
  // Fetch public keys
  const keys = await getPublicKeys();
  
  // Find the matching certificate
  const cert = keys.public_certs.find(c => c.kid === header.kid);
  if (!cert) {
    throw new Error('No matching certificate found for token');
  }

  // Import the certificate for verification
  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(cert.cert),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Split the token
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error('Invalid JWT format');
  }

  // Verify the signature
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, 'base64url');

  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    data
  );

  if (!isValid) {
    throw new Error('Invalid token signature');
  }

  // Decode the payload
  const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf-8');
  const claims = JSON.parse(payloadJson) as CloudflareAccessClaims;

  // Verify claims
  const now = Math.floor(Date.now() / 1000);

  if (claims.exp < now) {
    throw new Error('Token has expired');
  }

  if (claims.nbf && claims.nbf > now) {
    throw new Error('Token not yet valid');
  }

  // Verify audience if configured
  if (CF_ACCESS_AUD) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(CF_ACCESS_AUD)) {
      throw new Error('Invalid token audience');
    }
  }

  return claims;
}

/**
 * Convert PEM to ArrayBuffer
 */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace('-----BEGIN CERTIFICATE-----', '')
    .replace('-----END CERTIFICATE-----', '')
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');

  const binary = Buffer.from(base64, 'base64');
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}

/**
 * Authenticate a request using Cloudflare Access
 * Falls back to allowing access if the UI is already protected by Cloudflare Access
 */
export async function authenticateRequest(
  event: APIGatewayProxyEventV2
): Promise<UserSession> {
  // Get the CF-Access-JWT-Assertion header
  const token = 
    event.headers['cf-access-jwt-assertion'] ||
    event.headers['CF-Access-JWT-Assertion'] ||
    event.headers['authorization']?.replace('Bearer ', '');

  // If no token, check if we should allow (UI is protected by Cloudflare Access)
  // The Origin header indicates the request is coming from our protected admin UI
  if (!token) {
    const origin = event.headers['origin'] || '';
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    
    // If request is from a known admin UI origin, allow with default admin session
    if (allowedOrigins.some(allowed => origin.includes(allowed)) || 
        origin.includes('admin-staging.rati.chat') || 
        origin.includes('admin.rati.chat')) {
      return {
        email: ADMIN_EMAILS[0] || 'admin@example.com',
        userId: 'admin-ui-user',
        isAdmin: true,
        accessToken: '',
      };
    }
    
    throw new Error('No authentication token provided');
  }

  // Verify the token
  const claims = await verifyAccessToken(token);

  // Check if user is an admin
  const isAdmin = ADMIN_EMAILS.includes(claims.email);

  return {
    email: claims.email,
    userId: claims.sub,
    isAdmin,
    accessToken: token,
  };
}

/**
 * Require admin access - returns true if admin, false otherwise
 */
export function requireAdmin(session: UserSession): boolean {
  return session.isAdmin;
}

/**
 * Create a session for development/testing (when CF Access is not configured)
 */
export function createDevSession(email: string = 'dev@localhost'): UserSession {
  return {
    email,
    userId: 'dev-user',
    isAdmin: true,
    accessToken: 'dev-token',
  };
}
