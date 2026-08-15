import { prismaService, type PrismaClient } from '@repo/db';

import type { ExclusionReason, PlannedPost } from './ingest.ts';

/**
 * The narrow write surface `pollChannel` needs.
 *
 * A port rather than `PrismaClient` directly, so the poll cycle's rules — which
 * post is due, which exclusion is counted, which timestamp a snapshot carries —
 * are testable without a database, and so the Prisma calls stay in one file
 * that can be read against the schema.
 *
 * Every method here writes through `prismaService`, the BYPASSRLS credential.
 * Corpus tables carry RLS forced with zero policies (spec §3c), so there is no
 * other credential that can reach them at all — which is precisely why this is
 * a separate process from `apps/api`.
 */

export interface StoredPost {
  id: string;
  platformVideoId: string;
  firstSeenAt: Date;
  lastSnapshotAt: Date | null;
}

export interface SnapshotRow {
  postId: string;
  capturedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface CorpusStore {
  upsertChannel(input: {
    platformChannelId: string;
    title: string | null;
    niche: string;
    rationale: string;
    uploadsPlaylistId: string | null;
    subscriberCount: number | null;
    runAt: Date;
  }): Promise<{ id: string }>;

  /** Upserts the posts and returns them with what cadence needs to decide. */
  upsertPosts(channelId: string, posts: PlannedPost[], runAt: Date): Promise<StoredPost[]>;

  /** Appends snapshots, skipping any that already exist. Returns rows written. */
  appendSnapshots(rows: SnapshotRow[]): Promise<number>;

  recordPollRun(input: {
    channelId: string;
    runAt: Date;
    videosSeen: number;
    postsIncluded: number;
    excluded: Record<ExclusionReason, number>;
  }): Promise<void>;
}

export function prismaStore(db: PrismaClient = prismaService): CorpusStore {
  return {
    async upsertChannel(input) {
      return db.corpusChannel.upsert({
        where: { platformChannelId: input.platformChannelId },
        create: {
          platformChannelId: input.platformChannelId,
          title: input.title,
          niche: input.niche,
          rationale: input.rationale,
          uploadsPlaylistId: input.uploadsPlaylistId,
          subscriberCount: input.subscriberCount,
          lastPolledAt: input.runAt,
          textRefreshedAt: input.runAt,
        },
        update: {
          title: input.title,
          niche: input.niche,
          rationale: input.rationale,
          uploadsPlaylistId: input.uploadsPlaylistId,
          subscriberCount: input.subscriberCount,
          lastPolledAt: input.runAt,
          // Refreshing the text resets the 30-day clock. The nightly sweep is a
          // backstop for rows the poller has stopped reaching, not the primary
          // mechanism (spec §6).
          textRefreshedAt: input.runAt,
        },
        select: { id: true },
      });
    },

    async upsertPosts(channelId, posts, runAt) {
      const out: StoredPost[] = [];
      for (const post of posts) {
        const row = await db.corpusPost.upsert({
          where: { platformVideoId: post.platformVideoId },
          create: {
            channelId,
            platformVideoId: post.platformVideoId,
            publishedAt: post.publishedAt,
            durationSec: post.durationSec,
            title: post.title,
            description: post.description,
            tags: post.tags,
            license: post.license,
            firstSeenAt: runAt,
            textRefreshedAt: runAt,
          },
          update: {
            // `publishedAt` and `durationSec` are re-read rather than left
            // alone: a re-uploaded video keeps its id, and a stale duration
            // would leave a >30 s clip inside a frame defined by <=30 s.
            publishedAt: post.publishedAt,
            durationSec: post.durationSec,
            title: post.title,
            description: post.description,
            tags: post.tags,
            license: post.license,
            textRefreshedAt: runAt,
          },
          select: {
            id: true,
            platformVideoId: true,
            firstSeenAt: true,
            snapshots: {
              select: { capturedAt: true },
              orderBy: { capturedAt: 'desc' },
              take: 1,
            },
          },
        });
        out.push({
          id: row.id,
          platformVideoId: row.platformVideoId,
          firstSeenAt: row.firstSeenAt,
          lastSnapshotAt: row.snapshots[0]?.capturedAt ?? null,
        });
      }
      return out;
    },

    async appendSnapshots(rows) {
      if (rows.length === 0) return 0;
      // `skipDuplicates` plus the deterministic `capturedAt` is what makes an
      // at-least-once retry a no-op: the second attempt collides with its own
      // earlier write on `@@unique([postId, capturedAt])` instead of appending
      // a second observation of the same moment. Nothing is ever updated.
      const { count } = await db.corpusMetricSnapshot.createMany({
        data: rows.map((row) => ({
          postId: row.postId,
          capturedAt: row.capturedAt,
          views: row.views === null ? null : BigInt(row.views),
          likes: row.likes === null ? null : BigInt(row.likes),
          comments: row.comments === null ? null : BigInt(row.comments),
        })),
        skipDuplicates: true,
      });
      return count;
    },

    async recordPollRun(input) {
      await db.corpusPollRun.upsert({
        where: { channelId_runAt: { channelId: input.channelId, runAt: input.runAt } },
        create: {
          channelId: input.channelId,
          runAt: input.runAt,
          videosSeen: input.videosSeen,
          postsIncluded: input.postsIncluded,
          excluded: input.excluded,
        },
        update: {
          videosSeen: input.videosSeen,
          postsIncluded: input.postsIncluded,
          excluded: input.excluded,
        },
      });
    },
  };
}
