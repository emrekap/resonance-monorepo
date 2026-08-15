import { parseIsoDuration } from './duration.ts';
import type { YouTubeVideo } from './youtube.ts';

/**
 * Turning one channel's `videos.list` response into rows — the pure half.
 *
 * Separated from the writes so the frame's rules are testable without a
 * database, which is the same posture `apps/api` takes with `app.request()`.
 *
 * **What this excludes, and what it deliberately does not.** The only rule
 * applied here is the frame's own definition: a public, dated clip no longer
 * than `MAX_DURATION_SEC`. Every OTHER exclusion in spec §5b — age below the
 * maturation floor, hidden likes, the secondary outcome's denominator floor — is applied
 * at EXTRACT time, per-outcome, and applying any of them here would be a
 * different and much worse thing:
 *
 *   * an age floor at ingest never collects the post whose label matures next
 *     week, and the corpus would consist only of posts old enough on the day
 *     they were first seen;
 *   * a view floor at ingest is selection on the outcome variable — the exact
 *     flaw that disqualifies Instagram's `top_media` (§2), imported into our own
 *     method section;
 *   * a hidden-likes drop at ingest shrinks the PRIMARY outcome's N for a
 *     reason that belongs only to the secondary.
 */

/** The frame's upper bound. Stricter than the Shorts boundary, by design (§5b). */
export const MAX_DURATION_SEC = 30;

export type ExclusionReason =
  'duration_over_max_limit' | 'not_a_clip' | 'not_public' | 'missing_published_at';

const REASONS: ExclusionReason[] = [
  'duration_over_max_limit',
  'not_a_clip',
  'not_public',
  'missing_published_at',
];

export interface PlannedPost {
  platformVideoId: string;
  publishedAt: Date;
  durationSec: number;
  title: string | null;
  description: string | null;
  tags: string[];
  license: string | null;
}

export interface PlannedSnapshot {
  platformVideoId: string;
  capturedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface IngestPlan {
  posts: PlannedPost[];
  snapshots: PlannedSnapshot[];
  videosSeen: number;
  excluded: Record<ExclusionReason, number>;
}

export function planIngest(input: { videos: YouTubeVideo[]; runAt: Date }): IngestPlan {
  const posts: PlannedPost[] = [];
  const snapshots: PlannedSnapshot[] = [];
  const excluded = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<
    ExclusionReason,
    number
  >;

  for (const video of input.videos) {
    if (video.privacyStatus !== 'public') {
      excluded.not_public += 1;
      continue;
    }
    if (!video.publishedAt) {
      excluded.missing_published_at += 1;
      continue;
    }

    const durationSec = parseIsoDuration(video.duration);
    // `null` is "unreadable", `0` is a live broadcast reporting `P0D`. Neither
    // is a clip, and neither needs its own tally to be actionable.
    if (durationSec === null || durationSec <= 0) {
      excluded.not_a_clip += 1;
      continue;
    }
    if (durationSec > MAX_DURATION_SEC) {
      excluded.duration_over_max_limit += 1;
      continue;
    }

    posts.push({
      platformVideoId: video.id,
      publishedAt: new Date(video.publishedAt),
      durationSec,
      title: video.title,
      description: video.description,
      tags: video.tags,
      license: video.license,
    });

    snapshots.push({
      platformVideoId: video.id,
      // The RUN's timestamp, never `new Date()`: `@@unique([postId,
      // capturedAt])` is what makes a retried job collide with its own earlier
      // write instead of appending a second row for the same observation.
      capturedAt: input.runAt,
      views: video.views,
      likes: video.likes,
      comments: video.comments,
    });
  }

  return { posts, snapshots, videosSeen: input.videos.length, excluded };
}
