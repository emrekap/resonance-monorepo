/**
 * Supabase Storage, spoken with the *caller's* JWT.
 *
 * The API deliberately holds no storage service credential: a signed URL is
 * minted by forwarding the user's own access token, so Storage RLS
 * (`media_workspace_read`, rooted at the workspace id in the first path
 * segment) is the authorization check — the same policy that governed the
 * upload. A caller who cannot read an object cannot make the API sign it.
 */

/** The private bucket uploads land in. Policies live in the RLS migration. */
export const MEDIA_BUCKET = 'media';

/**
 * Lifetime of a minted download URL. Generous on purpose: the URL rides the
 * queue job, and the GPU worker may not pick it up for a while under load.
 */
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/api/.env.example`);
  return value;
}

function storageBase(): string {
  return `${required('SUPABASE_URL').replace(/\/+$/, '')}/storage/v1`;
}

/**
 * A time-limited download URL for an object in the `media` bucket, or null when
 * there is nothing at that path — which is how "the client never finished the
 * upload" surfaces, so callers treat null as *not uploaded*, not as an error.
 *
 * Storage answers a missing (or RLS-invisible — same thing from the caller's
 * point of view) object with 400 or 404 depending on version, so both map to
 * null; anything else non-2xx is a real failure and throws.
 */
export async function signedMediaUrl(path: string, accessToken: string): Promise<string | null> {
  const base = storageBase();
  const res = await fetch(`${base}/object/sign/${MEDIA_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      apikey: required('SUPABASE_PUBLISHABLE_KEY'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
  });

  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`storage sign for ${path} failed: ${res.status} ${await res.text()}`);

  const { signedURL } = (await res.json()) as { signedURL: string };
  return `${base}${signedURL}`;
}
