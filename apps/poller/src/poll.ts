import { isDue } from './cadence.ts';
import { planIngest, type IngestPlan } from './ingest.ts';
import type { SeedChannel } from './seeds.ts';
import type { CorpusStore, SnapshotRow } from './store.ts';
import type { YouTubeClient } from './youtube.ts';

/**
 * One channel's poll: traverse, plan, persist.
 *
 * Traversal is channel-first and does no discovery (spec §5a) —
 * `channels.list` for the uploads playlist and subscriber count,
 * `playlistItems.list` to walk it, `videos.list` batched 50 at a time. Three
 * calls of 1 quota unit each per channel, against a 10,000/day default.
 */

/** ~40 x 40 ~= 1,600 posts, above the prereg floor of >=20 per creator (§5d). */
export const POSTS_PER_CHANNEL = 40;

export interface PollOutcome {
  channelId: string | null;
  plan: IngestPlan | null;
  snapshotsWritten: number;
  /** Set when the channel could not be traversed at all. */
  skipped: 'no_uploads_playlist' | 'channel_not_found' | null;
}

export async function pollChannel(input: {
  seed: SeedChannel;
  youtube: YouTubeClient;
  store: CorpusStore;
  runAt: Date;
  postsPerChannel: number;
}): Promise<PollOutcome> {
  const [channel] = await input.youtube.channels([input.seed.id]);
  if (!channel) {
    // A terminated or renamed channel. Reported, not thrown: the other 39
    // channels still have observations to append today, and a missed day is a
    // hole in a time series that cannot be backfilled later.
    return { channelId: null, plan: null, snapshotsWritten: 0, skipped: 'channel_not_found' };
  }

  const stored = await input.store.upsertChannel({
    platformChannelId: channel.id,
    title: channel.title,
    niche: input.seed.niche,
    rationale: input.seed.rationale,
    uploadsPlaylistId: channel.uploadsPlaylistId,
    subscriberCount: channel.subscriberCount,
    runAt: input.runAt,
  });

  if (!channel.uploadsPlaylistId) {
    return {
      channelId: stored.id,
      plan: null,
      snapshotsWritten: 0,
      skipped: 'no_uploads_playlist',
    };
  }

  const videoIds = await input.youtube.uploads(channel.uploadsPlaylistId, input.postsPerChannel);
  const videos = await input.youtube.videos(videoIds);
  const plan = planIngest({ videos, runAt: input.runAt });

  const posts = await input.store.upsertPosts(stored.id, plan.posts, input.runAt);
  const byVideoId = new Map(posts.map((post) => [post.platformVideoId, post]));

  // Cadence gates the WRITE, not the fetch: `videos.list` costs one unit for
  // the whole batch of 50, so fetching fewer saves nothing — while an unwritten
  // snapshot saves a row in the 36-month tier and keeps the series at the
  // density §5c asks for.
  const rows: SnapshotRow[] = [];
  for (const snapshot of plan.snapshots) {
    const post = byVideoId.get(snapshot.platformVideoId);
    if (!post || !isDue(post, input.runAt)) continue;
    rows.push({
      postId: post.id,
      capturedAt: snapshot.capturedAt,
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
    });
  }

  const snapshotsWritten = await input.store.appendSnapshots(rows);

  await input.store.recordPollRun({
    channelId: stored.id,
    runAt: input.runAt,
    videosSeen: plan.videosSeen,
    postsIncluded: plan.posts.length,
    excluded: plan.excluded,
  });

  return { channelId: stored.id, plan, snapshotsWritten, skipped: null };
}
