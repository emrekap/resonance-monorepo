import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
// Enums come from `@repo/db/enums`, not `@repo/db`. Both re-export the same
// objects, but `status` below reaches `dist/app.d.ts`, and only the leaf is
// safe to name there — see the note in apps/api/README.md.
import { AnalysisStatus, MediaKind, MediaSource, MediaStatus } from '@repo/db/enums';
import type { AnalysisJob, Modality } from '@repo/queue';
import type { AuthEnv } from '../../middleware/auth';
import { EXTERNAL_BUCKET, externalUrl } from '../../lib/media';
import { MEDIA_BUCKET, signedMediaUrl } from '../../lib/storage';
import { enqueueAnalysis } from '../../lib/queue';
import { resolveWorkspaceId } from '../../lib/workspace';

const body = z
  .object({
    /** An asset registered via `POST /media` (or an earlier analysis). */
    mediaAssetId: z.uuid().optional(),
    /** Or a URL we register on the fly. See EXTERNAL_BUCKET. */
    mediaUrl: z.url().optional(),
    modality: z.enum(['video', 'audio']).default('video'),
    /** Omit for the caller's personal workspace. */
    workspaceId: z.uuid().optional(),
  })
  .refine((b) => Boolean(b.mediaAssetId) !== Boolean(b.mediaUrl), {
    message: 'provide exactly one of mediaAssetId or mediaUrl',
  });

const KIND_BY_MODALITY = { video: MediaKind.VIDEO, audio: MediaKind.AUDIO } as const;

/**
 * The reverse map, for an asset referenced by id: what the queue job says has to
 * come from the stored asset, not from a `modality` the client is free to set to
 * anything. IMAGE is absent because TRIBE takes video or audio.
 */
const MODALITY_BY_KIND: Partial<Record<MediaKind, Modality>> = {
  [MediaKind.VIDEO]: 'video',
  [MediaKind.AUDIO]: 'audio',
};

type LocatedAsset = {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  storageBucket: string;
  storagePath: string;
};

/** What the first transaction hands back. Both misses answer the same 404. */
type Located =
  { ok: true; workspaceId: string; asset: LocatedAsset } | { ok: false; reason: 'not_found' };

/**
 * `POST /analyze` — record the intent to analyse a piece of media, then queue it.
 *
 * Only records and queues it: the GPU work belongs to the Python worker
 * (`apps/ml`), which takes the job off the `analysis` queue and reports back on
 * `analysis-results`, where `apps/worker` persists the outcome as `app_service`.
 * The client polls `GET /analyze/:jobId`.
 *
 * Two `c.var.db(...)` transactions rather than one, because resolving the media
 * URL for a Storage asset is an HTTP call (signing under the caller's JWT) that
 * has no business holding a database transaction open. Worst case between them
 * is an orphaned `media_assets` row — a library entry with no analysis, which
 * is a valid state anyway. The enqueue stays *outside* both: publishing a job
 * id that a rollback then erases would hand the worker an analysis that does
 * not exist.
 */
export const createAnalysis = new Hono<AuthEnv>().post('/', zValidator('json', body), async (c) => {
  const { mediaAssetId, mediaUrl, modality, workspaceId: requested } = c.req.valid('json');
  const { id: profileId } = c.get('user');

  const located = await c.var.db<Located>(async (tx) => {
    const workspaceId = await resolveWorkspaceId(tx, profileId, requested);
    if (!workspaceId) return { ok: false, reason: 'not_found' };

    if (mediaAssetId) {
      // RLS alone would still allow referencing an asset from another
      // workspace the caller happens to belong to.
      const existing = await tx.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        select: {
          id: true,
          workspaceId: true,
          kind: true,
          status: true,
          storageBucket: true,
          storagePath: true,
        },
      });
      if (existing?.workspaceId !== workspaceId) return { ok: false, reason: 'not_found' };
      return { ok: true, workspaceId, asset: existing };
    }

    const asset = await tx.mediaAsset.create({
      data: {
        workspaceId,
        uploadedById: profileId,
        kind: KIND_BY_MODALITY[modality],
        source: MediaSource.UPLOAD,
        status: MediaStatus.READY,
        storageBucket: EXTERNAL_BUCKET,
        storagePath: mediaUrl!,
      },
      select: { id: true, kind: true, status: true, storageBucket: true, storagePath: true },
    });
    return { ok: true, workspaceId, asset };
  });

  if (!located.ok) {
    // One 404 for both misses on purpose: saying which of the two was missing
    // would confirm the existence of a workspace the caller cannot see.
    return c.json({ error: 'workspace_or_media_not_found' as const }, 404);
  }
  const { workspaceId, asset } = located;

  // Both checks read the *stored* asset, so they hold for an id the client
  // passed in exactly as they do for the row we just wrote.
  const assetModality = MODALITY_BY_KIND[asset.kind];
  if (!assetModality) return c.json({ error: 'unsupported_media_kind' as const }, 400);

  // The worker fetches by URL. An external asset carries one; a Storage object
  // gets a short-lived signed URL minted with the caller's own JWT, so Storage
  // RLS doubles as the did-the-upload-actually-finish check. Refused here
  // rather than queued to fail on a GPU.
  let url = externalUrl(asset);
  if (!url && asset.storageBucket === MEDIA_BUCKET) {
    url = await signedMediaUrl(asset.storagePath, c.get('accessToken'));
    if (!url) return c.json({ error: 'media_not_uploaded' as const }, 400);
  }
  if (!url) return c.json({ error: 'media_not_fetchable' as const }, 400);

  const prepared = await c.var.db(async (tx) => {
    // The signed URL above proved the object is really in Storage.
    if (asset.status === MediaStatus.PENDING) {
      await tx.mediaAsset.update({
        where: { id: asset.id },
        data: { status: MediaStatus.READY },
      });
    }

    // Checked again by analyses_insert (is_workspace_member), so a workspace
    // id that slipped past resolveWorkspaceId is still refused by Postgres.
    return tx.analysis.create({
      data: { workspaceId, mediaAssetId: asset.id, requestedById: profileId },
      select: { id: true, status: true },
    });
  });

  const job: AnalysisJob = {
    analysisId: prepared.id,
    workspaceId,
    modality: assetModality,
    media: { assetId: asset.id, url },
  };

  try {
    await enqueueAnalysis(job);
  } catch (cause) {
    // The row is committed and says QUEUED, but nothing will ever consume it.
    // Close it out rather than leave a job the client polls forever. Retrying
    // the POST is safe: it is a new analysis, and the id doubles as the BullMQ
    // job id, so even a duplicate delivery cannot run the GPU work twice.
    console.error(`enqueue failed for analysis ${prepared.id}:`, cause);
    await c.var.db((tx) =>
      tx.analysis.update({
        where: { id: prepared.id },
        data: { status: AnalysisStatus.FAILED, error: 'enqueue_failed', completedAt: new Date() },
      }),
    );
    return c.json({ error: 'queue_unavailable' as const }, 503);
  }

  return c.json({ jobId: prepared.id, status: prepared.status }, 202);
});
