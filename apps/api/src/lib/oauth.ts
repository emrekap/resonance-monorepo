import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Platform } from '@repo/db/enums';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/api/.env.example`);
  return value;
}

// ---------------------------------------------------------------------------
// Token sealing — connected_accounts.access_token / refresh_token hold
// AES-256-GCM ciphertext (see the schema comment), never plaintext, so a DB
// leak does not leak platform credentials. Layout: iv(12) ‖ tag(16) ‖ data.
// ---------------------------------------------------------------------------

function encryptionKey(): Buffer {
  const key = Buffer.from(required('TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes base64 — `openssl rand -base64 32`');
  }
  return key;
}

export function sealToken(plaintext: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // Copy out of Buffer: Prisma's Bytes input is typed Uint8Array<ArrayBuffer>,
  // and Buffer is Uint8Array<ArrayBufferLike>.
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), data]));
}

/** Inverse of `sealToken` — for the future sync jobs that call platform APIs. */
export function unsealToken(sealed: Uint8Array): string {
  const buf = Buffer.from(sealed);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Connect-flow state — the OAuth callback arrives as a bare browser redirect
// with no Authorization header, so the request context (who is connecting,
// into which workspace, back to which app URL) rides in `state`, HMAC-signed
// so the callback can trust it. Short-lived: it exists for one consent hop.
// ---------------------------------------------------------------------------

export interface ConnectState {
  profileId: string;
  workspaceId: string;
  platform: Platform;
  /** App deep link the callback redirects the browser back to. */
  returnTo: string;
  /** Unix ms expiry — a state is not a durable capability. */
  exp: number;
  nonce: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function stateHmac(payload: string): Buffer {
  return createHmac('sha256', required('OAUTH_STATE_SECRET')).update(payload).digest();
}

export function mintConnectState(input: Omit<ConnectState, 'exp' | 'nonce'>): {
  state: ConnectState;
  signed: string;
} {
  const state: ConnectState = {
    ...input,
    exp: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(16).toString('hex'),
  };
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return { state, signed: `${payload}.${stateHmac(payload).toString('base64url')}` };
}

/** Null on any defect — tampered, malformed, or expired. The caller answers 400. */
export function verifyConnectState(signed: string): ConnectState | null {
  const [payload, mac] = signed.split('.');
  if (!payload || !mac) return null;

  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  const expected = stateHmac(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConnectState;
    if (typeof state.exp !== 'number' || state.exp < Date.now()) return null;
    return state;
  } catch {
    return null;
  }
}
