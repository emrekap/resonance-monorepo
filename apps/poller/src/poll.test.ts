import { describe, expect, test } from 'bun:test';

import type { SeedChannel } from './seeds.ts';
import type { CorpusStore, StoredPost } from './store.ts';
import { POSTS_PER_CHANNEL, pollChannel } from './poll.ts';
import type { YouTubeChannel, YouTubeClient, YouTubeVideo } from './youtube.ts';

const RUN_AT = new Date('2026-08-12T03:00:00.000Z');
const daysBefore = (n: number) => new Date(RUN_AT.getTime() - n * 86_400_000);

const SEED: SeedChannel = {
  id: 'UCabcdefghijklmnopqrstuv',
  handle: '@example',
  niche: 'cooking',
  tier: 'mid',
  rationale: 'Posts 3-5 Shorts a week with visibly variable reach; not a repost account.',
};

const video = (id: string, overrides: Partial<YouTubeVideo> = {}): YouTubeVideo => ({
  id,
  channelId: SEED.id,
  publishedAt: '2026-08-01T12:00:00Z',
  title: `title ${id}`,
  description: '',
  tags: [],
  duration: 'PT20S',
  license: 'youtube',
  privacyStatus: 'public',
  views: 100,
  likes: 10,
  comments: 1,
  ...overrides,
});

// The fakes below answer with `Promise.resolve` rather than `async`: nothing
// here awaits, and `@typescript-eslint/require-await` rejects an async function
// with no await. Same posture as `youtube.test.ts`'s fake fetch.
function fakeYouTube(videos: YouTubeVideo[], channel: Partial<YouTubeChannel> = {}): YouTubeClient {
  return {
    channels() {
      return Promise.resolve([
        {
          id: SEED.id,
          title: 'Example Kitchen',
          uploadsPlaylistId: 'UUabcdefghijklmnopqrstuv',
          subscriberCount: 184000,
          ...channel,
        },
      ]);
    },
    uploads(_playlistId, limit) {
      return Promise.resolve(videos.slice(0, limit).map((v) => v.id));
    },
    videos(ids) {
      return Promise.resolve(videos.filter((v) => ids.includes(v.id)));
    },
  };
}

function fakeStore(stored: StoredPost[] = []) {
  const appended: { postId: string; capturedAt: Date }[] = [];
  const runs: { videosSeen: number; postsIncluded: number; excluded: Record<string, number> }[] =
    [];
  const store: CorpusStore = {
    upsertChannel() {
      return Promise.resolve({ id: 'channel-uuid' });
    },
    upsertPosts(_channelId, posts) {
      return Promise.resolve(
        posts.map(
          (post) =>
            stored.find((s) => s.platformVideoId === post.platformVideoId) ?? {
              id: `post-${post.platformVideoId}`,
              platformVideoId: post.platformVideoId,
              firstSeenAt: RUN_AT,
              lastSnapshotAt: null,
            },
        ),
      );
    },
    appendSnapshots(rows) {
      appended.push(...rows.map((r) => ({ postId: r.postId, capturedAt: r.capturedAt })));
      return Promise.resolve(rows.length);
    },
    recordPollRun(input) {
      runs.push({
        videosSeen: input.videosSeen,
        postsIncluded: input.postsIncluded,
        excluded: input.excluded,
      });
      return Promise.resolve();
    },
  };
  return { store, appended, runs };
}

describe('pollChannel', () => {
  test('appends one snapshot per due post, stamped with the run timestamp', async () => {
    const { store, appended } = fakeStore();
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([video('a'), video('b')]),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });

    expect(outcome.snapshotsWritten).toBe(2);
    expect(appended.map((a) => a.capturedAt.toISOString())).toEqual([
      RUN_AT.toISOString(),
      RUN_AT.toISOString(),
    ]);
  });

  test('skips a post that is not due yet but keeps its row fresh', async () => {
    // Cadence controls WRITES, not fetches: `videos.list` costs one quota unit
    // for the whole batch, so there is nothing to save by fetching less — and
    // the text refresh on the post row is what keeps the 30-day clock reset.
    const { store, appended } = fakeStore([
      {
        id: 'post-a',
        platformVideoId: 'a',
        firstSeenAt: daysBefore(40),
        lastSnapshotAt: daysBefore(2),
      },
      {
        id: 'post-b',
        platformVideoId: 'b',
        firstSeenAt: daysBefore(2),
        lastSnapshotAt: daysBefore(1),
      },
    ]);
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([video('a'), video('b')]),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });

    // `a` is 40 days old on a weekly cadence, snapshotted 2 days ago: not due.
    // `b` is inside the daily window, snapshotted yesterday: due.
    expect(appended.map((a) => a.postId)).toEqual(['post-b']);
    expect(outcome.plan!.posts).toHaveLength(2);
  });

  test('records the run tallies, including exclusions that leave no row behind', async () => {
    const { store, runs } = fakeStore();
    await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([video('a'), video('long', { duration: 'PT4M' })]),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      videosSeen: 2,
      postsIncluded: 1,
      excluded: { duration_over_max_limit: 1 },
    });
  });

  test('caps the traversal at the configured posts per channel', async () => {
    const many = Array.from({ length: 100 }, (_, i) => video(`v${i}`));
    const { store } = fakeStore();
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube(many),
      store,
      runAt: RUN_AT,
      postsPerChannel: 40,
    });
    expect(outcome.plan!.videosSeen).toBe(40);
  });

  test('reports a channel with no uploads playlist instead of throwing', async () => {
    // A deleted or terminated channel must not take the whole run down — the
    // other 39 channels still have observations to append today, and a missed
    // day is a hole in a time series that cannot be backfilled.
    const { store } = fakeStore();
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([], { uploadsPlaylistId: null }),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });
    expect(outcome.skipped).toBe('no_uploads_playlist');
    expect(outcome.snapshotsWritten).toBe(0);
  });

  test('reports a channel the API does not return', async () => {
    const { store } = fakeStore();
    const youtube: YouTubeClient = {
      ...fakeYouTube([]),
      channels() {
        return Promise.resolve([]);
      },
    };
    const outcome = await pollChannel({
      seed: SEED,
      youtube,
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });
    expect(outcome.skipped).toBe('channel_not_found');
  });
});
