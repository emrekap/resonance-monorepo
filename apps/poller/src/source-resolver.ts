import { prismaService, type PrismaClient } from '@repo/db';
import type { CorpusJob } from '@repo/queue';

/**
 * The deferred half — source files (spec §7).
 *
 * TRIBE needs the video file, and the Data API does not provide one. The
 * validation spec's §11a lists three routes — creator upload,
 * capture-at-post-time, and scraping the published stream — and rules the third
 * out for a diligence artifact. **This module does not reverse that ruling; it
 * defers it**, behind one interface with one method, and `corpus.clips` stays
 * empty until the decision is made deliberately.
 *
 * What makes the deferral nearly free is one column. `videos.list?part=status`
 * returns `status.license` at no extra quota on the call already being made, so
 * after two weeks of polling "do enough channels have >=20 Creative-Commons
 * clips under 30 s?" is a SQL query against the corpus rather than a separate
 * research exercise — and whichever route is eventually chosen, no re-crawl is
 * needed. The weekly readiness report puts that number in front of somebody
 * every Monday.
 *
 * For the record, so the eventual decision is made on facts: a CC-BY licence
 * resolves the **copyright** question (the uploader has granted reuse,
 * including commercial, with attribution) and does **not** resolve the **ToS**
 * question (YouTube's terms still bar access by unauthorised means; the
 * realistic exposure is API-project termination rather than litigation). Those
 * two halves are routinely conflated and are not conflated here — which is why
 * the default resolver returns nothing even for a post whose licence looks
 * permissive.
 */

export interface CorpusPostRef {
  id: string;
  platformVideoId: string;
  durationSec: number;
  license: string | null;
}

export interface ResolvedClip {
  storageKey: string;
  checksumSha256: string;
  durationSec: number | null;
  /** `creator_upload` | `capture_at_post_time` | … — recorded per clip, because
   *  the routes carry different licence and ToS positions. */
  acquisitionRoute: string;
  /** Where `apps/ml` fetches the bytes. Short-lived. */
  url: string;
}

export interface SourceResolver {
  resolve(post: CorpusPostRef): Promise<ResolvedClip | null>;
}

/** The only implementation today. Resolves nothing, on purpose. */
export const nullSourceResolver: SourceResolver = {
  resolve() {
    return Promise.resolve(null);
  },
};

const RESOLVERS: Record<string, SourceResolver> = {
  none: nullSourceResolver,
};

export function sourceResolver(
  name: string = process.env.CORPUS_SOURCE_RESOLVER ?? 'none',
): SourceResolver {
  const resolver = RESOLVERS[name];
  if (!resolver) {
    // Not a silent fallback to `none`: a typo would then look identical to the
    // deferred state, and a backfill that acquires nothing would look healthy.
    throw new Error(
      `unknown CORPUS_SOURCE_RESOLVER "${name}" — known: ${Object.keys(RESOLVERS).join(', ')}`,
    );
  }
  return resolver;
}

export interface ClipStore {
  hasClip(postId: string): Promise<boolean>;
  recordClip(postId: string, clip: ResolvedClip): Promise<{ id: string }>;
}

export function prismaClipStore(db: PrismaClient = prismaService): ClipStore {
  return {
    async hasClip(postId) {
      return (await db.corpusClip.count({ where: { postId } })) > 0;
    },
    async recordClip(postId, clip) {
      return db.corpusClip.upsert({
        where: { postId },
        create: {
          postId,
          storageKey: clip.storageKey,
          checksumSha256: clip.checksumSha256,
          durationSec: clip.durationSec,
          acquisitionRoute: clip.acquisitionRoute,
        },
        update: {
          storageKey: clip.storageKey,
          checksumSha256: clip.checksumSha256,
          durationSec: clip.durationSec,
          acquisitionRoute: clip.acquisitionRoute,
        },
        select: { id: true },
      });
    },
  };
}

/**
 * Acquire what can be acquired and queue it for scoring.
 *
 * The clip row is written BEFORE the job is enqueued so a job never references
 * a clip that does not exist. The reverse order would leave `apps/ml` running
 * inference whose result `apps/poller` then cannot attach to anything.
 */
export async function backfillClips(input: {
  posts: CorpusPostRef[];
  resolver: SourceResolver;
  store: ClipStore;
  enqueue: (job: CorpusJob) => Promise<void>;
}): Promise<{ resolved: number; enqueued: number; skipped: number }> {
  let resolved = 0;
  let enqueued = 0;
  let skipped = 0;

  for (const post of input.posts) {
    if (await input.store.hasClip(post.id)) {
      skipped += 1;
      continue;
    }

    const clip = await input.resolver.resolve(post);
    if (!clip) continue;
    resolved += 1;

    const row = await input.store.recordClip(post.id, clip);
    await input.enqueue({
      corpusPostId: post.id,
      clipId: row.id,
      modality: 'video',
      media: { url: clip.url },
    });
    enqueued += 1;
  }

  return { resolved, enqueued, skipped };
}
