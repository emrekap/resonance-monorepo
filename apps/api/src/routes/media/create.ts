import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { MediaKind, MediaSource, MediaStatus } from '@repo/db/enums';
import type { AuthEnv } from '../../middleware/auth';
import { MEDIA_BUCKET } from '../../lib/storage';
import { resolveWorkspaceId } from '../../lib/workspace';

const body = z.object({
  kind: z.enum(['video', 'audio', 'image']),
  /** Advisory — Storage checks the real content type against the bucket's allowlist. */
  mimeType: z
    .string()
    .regex(/^[-\w.]+\/[-+.\w]+$/)
    .optional(),
  byteSize: z.number().int().positive().optional(),
  /** Omit for the caller's personal workspace. */
  workspaceId: z.uuid().optional(),
});

const KIND_BY_PARAM = {
  video: MediaKind.VIDEO,
  audio: MediaKind.AUDIO,
  image: MediaKind.IMAGE,
} as const;

/**
 * `POST /media` — step one of the upload flow: register the asset, get back the
 * Storage location to upload to.
 *
 * The client then PUTs the bytes straight to Supabase Storage with its *own*
 * JWT — the file never streams through this API, and the Storage RLS policy
 * (first path segment = a workspace the caller belongs to) authorizes the
 * write, not us. The row starts PENDING; `POST /analyze` verifies the object
 * exists (by minting a signed URL under the same RLS) and flips it READY.
 */
export const createMediaAsset = new Hono<AuthEnv>().post(
  '/',
  zValidator('json', body),
  async (c) => {
    const { kind, mimeType, byteSize, workspaceId: requested } = c.req.valid('json');
    const { id: profileId } = c.get('user');

    const created = await c.var.db(async (tx) => {
      const workspaceId = await resolveWorkspaceId(tx, profileId, requested);
      if (!workspaceId) return null;

      // Minted here rather than by the column default because the storage path
      // embeds the id, and the row should land with its final path in one insert.
      const id = Bun.randomUUIDv7();
      return tx.mediaAsset.create({
        data: {
          id,
          workspaceId,
          uploadedById: profileId,
          kind: KIND_BY_PARAM[kind],
          source: MediaSource.UPLOAD,
          status: MediaStatus.PENDING,
          storageBucket: MEDIA_BUCKET,
          storagePath: `${workspaceId}/${id}`,
          mimeType,
          byteSize: byteSize === undefined ? undefined : BigInt(byteSize),
        },
        select: { id: true, storageBucket: true, storagePath: true },
      });
    });

    // 404, not 403: naming the workspace would confirm it exists to a non-member.
    if (!created) return c.json({ error: 'workspace_not_found' as const }, 404);

    return c.json(
      { mediaAssetId: created.id, bucket: created.storageBucket, path: created.storagePath },
      201,
    );
  },
);
