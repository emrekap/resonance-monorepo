import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { MediaKind, MediaSource, MediaStatus, type AnalysisStatus, type Tx } from '@repo/db';
import { requireAuth, type AuthEnv } from '../middleware/auth';
import { resolveWorkspaceId } from '../lib/workspace';

/**
 * The DB enums re-declared as plain literals for the wire.
 *
 * `AppType` crosses into the Expo/Next typecheck as a d.ts, so a Prisma type in
 * a response would drag the whole generated client — and its Bun/Node globals —
 * into a React Native tsconfig. Mapping through these keeps the boundary clean
 * without duplicating the enum by hand: `satisfies Record<Enum, string>` stops
 * compiling the moment a value is added to the Postgres enum.
 */
const JOB_STATUS = {
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const satisfies Record<AnalysisStatus, string>;

const MEDIA_KIND_OUT = {
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  IMAGE: 'IMAGE',
} as const satisfies Record<MediaKind, string>;

/**
 * Where a `mediaUrl` lands until the signed-upload flow exists.
 *
 * `media_assets` models an object in our Storage (`{workspace_id}/{asset_id}`),
 * not an arbitrary URL, so a caller-supplied URL is parked under its own bucket
 * name to stay unambiguously distinguishable from a real uploaded object. Once
 * clients upload through Storage they will register the asset first and pass
 * `mediaAssetId`, and this branch goes away.
 */
const EXTERNAL_BUCKET = 'external';

const MEDIA_KIND = { video: MediaKind.VIDEO, audio: MediaKind.AUDIO } as const;

const analyzeBody = z
  .object({
    /** An already-registered asset — the shape this settles on. */
    mediaAssetId: z.uuid().optional(),
    /** Or a URL we register on the fly. See EXTERNAL_BUCKET. */
    mediaUrl: z.url().optional(),
    modality: z.enum(['video', 'audio']).default('video'),
    /** Omit for the caller's personal workspace. */
    workspaceId: z.uuid().optional(),
  })
  .refine((body) => Boolean(body.mediaAssetId) !== Boolean(body.mediaUrl), {
    message: 'provide exactly one of mediaAssetId or mediaUrl',
  });

const jobParam = z.object({ jobId: z.uuid() });

/**
 * Analyze endpoints — persisted in Postgres via `@repo/db`.
 *
 * Every query runs through `c.var.db` (= `withUser` bound to the caller), so
 * row visibility is enforced by Postgres RLS rather than by `where` clauses
 * here: a job id belonging to another workspace reads back as "not found" even
 * though the handler asks for it by primary key.
 *
 * `POST /analyze` only records the intent. The GPU work belongs to the Python
 * worker (`apps/ml`), which picks the job off the queue and writes the result
 * as `app_service`; the client polls `GET /analyze/:jobId`.
 */
export const analyze = new Hono<AuthEnv>()
  .use('*', requireAuth)
  .post('/', zValidator('json', analyzeBody), async (c) => {
    const { mediaAssetId, mediaUrl, modality, workspaceId: requested } = c.req.valid('json');
    const user = c.get('user');

    const created = await c.var.db(async (tx) => {
      const workspaceId = await resolveWorkspaceId(tx, user.id, requested);
      if (!workspaceId) return null;

      const assetId = mediaAssetId
        ? await findAsset(tx, mediaAssetId, workspaceId)
        : await registerExternalAsset(tx, workspaceId, user.id, mediaUrl!, modality);
      if (!assetId) return null;

      // The INSERT is still checked by analyses_insert (is_workspace_member),
      // so a workspace id smuggled past resolveWorkspaceId is refused anyway.
      return tx.analysis.create({
        data: { workspaceId, mediaAssetId: assetId, requestedById: user.id },
        select: { id: true, status: true },
      });
    });

    if (!created) return c.json({ error: 'workspace_or_media_not_found' as const }, 404);

    // TODO: enqueue (Redis/BullMQ) -> the apps/ml worker writes analysis_results.
    return c.json({ jobId: created.id, status: JOB_STATUS[created.status] }, 202);
  })
  .get('/:jobId', zValidator('param', jobParam), async (c) => {
    const { jobId } = c.req.valid('param');

    const analysis = await c.var.db((tx) =>
      tx.analysis.findUnique({
        where: { id: jobId },
        // Selected explicitly rather than `include`d: `media_assets.byte_size`
        // is a BigInt (JSON.stringify throws on it) and `analysis_results
        // .raw_stats` is dev telemetry that must never reach a creator.
        select: {
          id: true,
          status: true,
          workspaceId: true,
          error: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          mediaAsset: {
            select: { id: true, kind: true, storageBucket: true, storagePath: true },
          },
          result: {
            select: { resonanceScore: true, percentileInChannel: true, confidence: true },
          },
        },
      }),
    );

    if (!analysis) return c.json({ error: 'job_not_found' as const }, 404);

    const { id, status, mediaAsset, ...rest } = analysis;
    return c.json({
      jobId: id,
      status: JOB_STATUS[status],
      media: {
        id: mediaAsset.id,
        kind: MEDIA_KIND_OUT[mediaAsset.kind],
        // An external URL was stored as the path; a real upload has a bucket.
        url: mediaAsset.storageBucket === EXTERNAL_BUCKET ? mediaAsset.storagePath : null,
      },
      ...rest,
    });
  });

/** Confirms the asset is visible to the caller *and* in the target workspace. */
async function findAsset(tx: Tx, id: string, workspaceId: string): Promise<string | null> {
  const asset = await tx.mediaAsset.findUnique({ where: { id }, select: { workspaceId: true } });
  return asset?.workspaceId === workspaceId ? id : null;
}

async function registerExternalAsset(
  tx: Tx,
  workspaceId: string,
  profileId: string,
  mediaUrl: string,
  modality: keyof typeof MEDIA_KIND,
): Promise<string> {
  const asset = await tx.mediaAsset.create({
    data: {
      workspaceId,
      uploadedById: profileId,
      kind: MEDIA_KIND[modality],
      source: MediaSource.UPLOAD,
      status: MediaStatus.READY,
      storageBucket: EXTERNAL_BUCKET,
      storagePath: mediaUrl,
    },
    select: { id: true },
  });
  return asset.id;
}
