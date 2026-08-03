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
import { enqueueAnalysis } from '../../lib/queue';
import { resolveWorkspaceId } from '../../lib/workspace';

const body = z
  .object({
    /** An already-registered asset — the shape this settles on. */
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

/** What the transaction hands back. The failures differ; two of them still answer 404. */
type Prepared =
  | { ok: true; analysisId: string; status: AnalysisStatus; job: AnalysisJob }
  | { ok: false; reason: 'not_found' | 'unsupported_media_kind' | 'media_not_fetchable' };

/**
 * `POST /analyze` — record the intent to analyse a piece of media, then queue it.
 *
 * Only records and queues it: the GPU work belongs to the Python worker
 * (`apps/ml`), which takes the job off the `analysis` queue and reports back on
 * `analysis-results`, where `apps/worker` persists the outcome as `app_service`.
 * The client polls `GET /analyze/:jobId`.
 *
 * All three writes share one `c.var.db(...)`, i.e. one `withUser` transaction —
 * they either all land under the caller's RLS claim or none do. The enqueue is
 * deliberately *outside* it: publishing a job id that a rollback then erases
 * would hand the worker an analysis that does not exist.
 */
export const createAnalysis = new Hono<AuthEnv>().post('/', zValidator('json', body), async (c) => {
  const { mediaAssetId, mediaUrl, modality, workspaceId: requested } = c.req.valid('json');
  const { id: profileId } = c.get('user');

  const prepared = await c.var.db<Prepared>(async (tx) => {
    const workspaceId = await resolveWorkspaceId(tx, profileId, requested);
    if (!workspaceId) return { ok: false, reason: 'not_found' };

    let asset;
    if (mediaAssetId) {
      // RLS alone would still allow referencing an asset from another
      // workspace the caller happens to belong to.
      const existing = await tx.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        select: { id: true, workspaceId: true, kind: true, storageBucket: true, storagePath: true },
      });
      if (existing?.workspaceId !== workspaceId) return { ok: false, reason: 'not_found' };
      asset = existing;
    } else {
      asset = await tx.mediaAsset.create({
        data: {
          workspaceId,
          uploadedById: profileId,
          kind: KIND_BY_MODALITY[modality],
          source: MediaSource.UPLOAD,
          status: MediaStatus.READY,
          storageBucket: EXTERNAL_BUCKET,
          storagePath: mediaUrl!,
        },
        select: { id: true, kind: true, storageBucket: true, storagePath: true },
      });
    }

    // Both checks read the *stored* asset, so they hold for an id the client
    // passed in exactly as they do for the row we just wrote.
    const assetModality = MODALITY_BY_KIND[asset.kind];
    if (!assetModality) return { ok: false, reason: 'unsupported_media_kind' };

    // Null once `media_assets` holds a real Storage object: the worker fetches
    // by URL, and minting a signed one belongs to the upload flow, which is not
    // written yet. Refused here rather than queued to fail on a GPU.
    const url = externalUrl(asset);
    if (!url) return { ok: false, reason: 'media_not_fetchable' };

    // Checked again by analyses_insert (is_workspace_member), so a workspace
    // id that slipped past resolveWorkspaceId is still refused by Postgres.
    const analysis = await tx.analysis.create({
      data: { workspaceId, mediaAssetId: asset.id, requestedById: profileId },
      select: { id: true, status: true },
    });

    return {
      ok: true,
      analysisId: analysis.id,
      status: analysis.status,
      job: {
        analysisId: analysis.id,
        workspaceId,
        modality: assetModality,
        media: { assetId: asset.id, url },
      },
    };
  });

  if (!prepared.ok) {
    // One 404 for both misses on purpose: saying which of the two was missing
    // would confirm the existence of a workspace the caller cannot see. The
    // other two reasons describe the caller's own asset, so they can be named.
    return prepared.reason === 'not_found'
      ? c.json({ error: 'workspace_or_media_not_found' as const }, 404)
      : c.json({ error: prepared.reason }, 400);
  }

  try {
    await enqueueAnalysis(prepared.job);
  } catch (cause) {
    // The row is committed and says QUEUED, but nothing will ever consume it.
    // Close it out rather than leave a job the client polls forever. Retrying
    // the POST is safe: it is a new analysis, and the id doubles as the BullMQ
    // job id, so even a duplicate delivery cannot run the GPU work twice.
    console.error(`enqueue failed for analysis ${prepared.analysisId}:`, cause);
    await c.var.db((tx) =>
      tx.analysis.update({
        where: { id: prepared.analysisId },
        data: { status: AnalysisStatus.FAILED, error: 'enqueue_failed', completedAt: new Date() },
      }),
    );
    return c.json({ error: 'queue_unavailable' as const }, 503);
  }

  return c.json({ jobId: prepared.analysisId, status: prepared.status }, 202);
});
