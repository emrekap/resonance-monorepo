/**
 * When a post is polled again — daily for two weeks, then weekly (spec §5c).
 *
 * This is the design's least obvious payoff. A single-shot crawl forces you to
 * *assume* when engagement has matured; a time series lets you **measure** it
 * (see `maturation.ts`). It also enables the fixed-age measurement the primary
 * label depends on — every post's views can be read at the same AGE rather than
 * the same calendar moment, which removes the dominant confound in any crawled
 * corpus by construction rather than by normalising it away. And it satisfies
 * YouTube's "keep stored data consistent with live YouTube" obligation as a
 * side effect of doing what the statistics already required.
 *
 * The window is measured from `firstSeenAt`, not `publishedAt`, per §5c: a
 * newly seeded channel's back catalogue gets its own two weeks of dense
 * observation, which is what makes a fixed-age read possible for a post that
 * was already old when the frame was curated.
 */

export const DAILY_WINDOW_DAYS = 14;
export const WEEKLY_INTERVAL_DAYS = 7;

/** Whole UTC days from `from` to `to`, floored. Never negative in practice. */
export function utcDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function pollIntervalDays(firstSeenAt: Date, runAt: Date): number {
  return utcDaysBetween(firstSeenAt, runAt) < DAILY_WINDOW_DAYS ? 1 : WEEKLY_INTERVAL_DAYS;
}

/**
 * Whether this run should append a snapshot for the post.
 *
 * A post with no snapshot is always due — that is the first observation, and
 * withholding it would leave a post with a label that can never be read.
 */
export function isDue(
  post: { firstSeenAt: Date; lastSnapshotAt: Date | null },
  runAt: Date,
): boolean {
  if (post.lastSnapshotAt === null) return true;
  return utcDaysBetween(post.lastSnapshotAt, runAt) >= pollIntervalDays(post.firstSeenAt, runAt);
}
