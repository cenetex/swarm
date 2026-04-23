/**
 * Callback-data signing for Telegram inline-keyboard buttons.
 *
 * Telegram caps `callback_data` at 64 bytes. We pack the logical payload
 * (action + target) into a short string and append an HMAC truncation so a
 * non-owner in the same chat can't forge a tap by sending a raw
 * callback_query through a scripted client.
 *
 * Wire format:  `<payload>.<sig>`
 *   - payload: UTF-8 string, no dots allowed
 *   - sig:     base64url-encoded first 8 bytes of HMAC-SHA256(payload, key)
 *
 * 8 bytes = 64 bits of integrity. With a rate-limited callback endpoint, the
 * expected cost of a forgery is effectively infinite for web-scale attackers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_BYTES = 8;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signCallbackData(payload: string, key: string): string {
  if (payload.includes('.')) {
    throw new Error('Callback-data payload must not contain "."');
  }
  if (!key) {
    throw new Error('Callback-data signing key is empty');
  }
  const mac = createHmac('sha256', key).update(payload, 'utf8').digest().subarray(0, SIG_BYTES);
  const signed = `${payload}.${base64url(mac)}`;
  if (Buffer.byteLength(signed, 'utf8') > 64) {
    throw new Error(`Signed callback_data exceeds Telegram's 64-byte limit: ${signed.length}`);
  }
  return signed;
}

export interface VerifyResult {
  ok: boolean;
  payload?: string;
  reason?: 'malformed' | 'bad_signature' | 'empty_key';
}

export function verifyCallbackData(data: string, key: string): VerifyResult {
  if (!key) return { ok: false, reason: 'empty_key' };

  const lastDot = data.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === data.length - 1) {
    return { ok: false, reason: 'malformed' };
  }
  const payload = data.slice(0, lastDot);
  const providedSigStr = data.slice(lastDot + 1);

  let providedSig: Buffer;
  try {
    providedSig = fromBase64url(providedSigStr);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (providedSig.length !== SIG_BYTES) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = createHmac('sha256', key).update(payload, 'utf8').digest().subarray(0, SIG_BYTES);
  // timingSafeEqual requires equal-length Buffers; lengths are already
  // validated above so this is safe.
  if (!timingSafeEqual(providedSig, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, payload };
}
