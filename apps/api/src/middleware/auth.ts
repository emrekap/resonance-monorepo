import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { withUser, type Tx } from '@repo/db';

/** The authenticated caller. `id` is `auth.users.id`, which is also `profiles.id`. */
export interface AuthUser {
  id: string;
  email: string | null;
  role: string;
}

/**
 * What `requireAuth` puts on the context.
 *
 * `db` is `withUser()` already bound to the caller, so a handler cannot
 * accidentally run a query as somebody else — the user id is not a parameter it
 * gets to choose.
 */
export type AuthEnv = {
  Variables: {
    user: AuthUser;
    db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  };
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/api/.env.example`);
  return value;
}

/**
 * Supabase signs access tokens with an asymmetric key (ES256) and publishes the
 * public half at the project's JWKS endpoint, so the API verifies signatures
 * locally — no round trip to GoTrue on every request.
 *
 * Built on first use rather than at import so route tests and `--dry-run`-style
 * imports don't need the env. `createRemoteJWKSet` caches the key set and
 * refetches only on an unknown `kid` (key rotation).
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let issuer: string | undefined;

function verifier() {
  if (!jwks) {
    const supabaseUrl = required('SUPABASE_URL').replace(/\/+$/, '');
    issuer = `${supabaseUrl}/auth/v1`;
    jwks = createRemoteJWKSet(
      new URL(process.env.SUPABASE_JWKS_URL ?? `${issuer}/.well-known/jwks.json`),
    );
  }
  return { jwks, issuer: issuer! };
}

function claim(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Verifies the `Authorization: Bearer <supabase access token>` header and binds
 * the request to that user's RLS scope.
 *
 * This is the only place a user id enters the system. Everything downstream
 * reads it from the context, so an id can never arrive from a request body and
 * be trusted.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return c.json({ error: 'unauthorized' as const }, 401);

  let payload: JWTPayload;
  try {
    const { jwks, issuer } = verifier();
    // `aud: authenticated` is what distinguishes a signed-in user's token from
    // an anon/publishable key, which carries the same issuer.
    ({ payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' }));
  } catch {
    return c.json({ error: 'invalid_token' as const }, 401);
  }

  if (!payload.sub) return c.json({ error: 'invalid_token' as const }, 401);

  const user: AuthUser = {
    id: payload.sub,
    email: claim(payload, 'email'),
    role: claim(payload, 'role') ?? 'authenticated',
  };

  c.set('user', user);
  c.set('db', (fn) => withUser(user.id, fn));

  await next();
});
