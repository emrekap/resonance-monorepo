/**
 * Where a caller-supplied `mediaUrl` lands until the signed-upload flow exists.
 *
 * `media_assets` models an object in our Storage (`{workspace_id}/{asset_id}`),
 * not an arbitrary URL, so a URL is parked under its own bucket name to stay
 * unambiguously distinguishable from a real uploaded object. Once clients
 * upload through Storage they will register the asset first and pass its id,
 * and this goes away.
 *
 * Shared rather than inlined because both `/analyze` routes need it — one to
 * write the bucket, one to read it back — and the future `/media` routes will
 * too.
 */
export const EXTERNAL_BUCKET = 'external';

/** The URL a client can fetch, or null once the asset is a real Storage object. */
export function externalUrl(asset: { storageBucket: string; storagePath: string }): string | null {
  return asset.storageBucket === EXTERNAL_BUCKET ? asset.storagePath : null;
}
