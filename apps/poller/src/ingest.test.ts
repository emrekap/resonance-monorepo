import { describe, expect, test } from 'bun:test';

import videosFixture from './__fixtures__/youtube/videos.json';
import { MAX_DURATION_SEC, planIngest } from './ingest.ts';
import type { YouTubeVideo } from './youtube.ts';

const RUN_AT = new Date('2026-08-12T03:00:00.000Z');

const video = (overrides: Partial<YouTubeVideo> = {}): YouTubeVideo => ({
  id: 'vid00000001',
  channelId: 'UCabcdefghijklmnopqrstuv',
  publishedAt: '2026-08-11T12:00:00Z',
  title: 'a short',
  description: '#tag',
  tags: ['tag'],
  duration: 'PT20S',
  license: 'youtube',
  privacyStatus: 'public',
  views: 1000,
  likes: 50,
  comments: 5,
  ...overrides,
});

const fixtureVideos = videosFixture.items.map((item) => ({
  id: item.id,
  channelId: item.snippet.channelId,
  publishedAt: item.snippet.publishedAt,
  title: item.snippet.title,
  description: item.snippet.description,
  tags: item.snippet.tags,
  duration: item.contentDetails.duration,
  license: item.status.license,
  privacyStatus: item.status.privacyStatus,
  views: item.statistics.viewCount ? Number(item.statistics.viewCount) : null,
  likes: item.statistics.likeCount ? Number(item.statistics.likeCount) : null,
  comments: item.statistics.commentCount ? Number(item.statistics.commentCount) : null,
})) as YouTubeVideo[];

describe('the frame', () => {
  test('includes a clip exactly at the boundary and excludes one past it', () => {
    const plan = planIngest({
      videos: [
        video({ id: 'at', duration: `PT${MAX_DURATION_SEC}S` }),
        video({ id: 'over', duration: `PT${MAX_DURATION_SEC + 1}S` }),
      ],
      runAt: RUN_AT,
    });
    expect(plan.posts.map((p) => p.platformVideoId)).toEqual(['at']);
    expect(plan.excluded.duration_over_30s).toBe(1);
  });

  test('excludes a live broadcast and a non-public video, each by its own reason', () => {
    const plan = planIngest({
      videos: [
        video({ id: 'live', duration: 'P0D' }),
        video({ id: 'unreadable', duration: 'sometime' }),
        video({ id: 'private', privacyStatus: 'private' }),
        video({ id: 'undated', publishedAt: null }),
      ],
      runAt: RUN_AT,
    });
    expect(plan.posts).toHaveLength(0);
    expect(plan.excluded).toEqual({
      not_a_clip: 2,
      not_public: 1,
      missing_published_at: 1,
      duration_over_30s: 0,
    });
  });

  test('every video is either included or counted, never neither', () => {
    // The readiness report states exclusions BY REASON (spec §12.2). A video
    // that falls out of the plan without landing in a tally is a corpus whose
    // own denominator cannot be reconstructed.
    const plan = planIngest({ videos: fixtureVideos, runAt: RUN_AT });
    const tallied = Object.values(plan.excluded).reduce((a, b) => a + b, 0);
    expect(plan.posts.length + tallied).toBe(plan.videosSeen);
    expect(plan.videosSeen).toBe(fixtureVideos.length);
  });
});

describe('what is NOT excluded here', () => {
  test('keeps a post younger than the maturation floor', () => {
    // Applying the age floor at ingest would mean never collecting the post
    // whose label matures next week. Age is an EXTRACT-time exclusion.
    const plan = planIngest({
      videos: [video({ publishedAt: RUN_AT.toISOString() })],
      runAt: RUN_AT,
    });
    expect(plan.posts).toHaveLength(1);
  });

  test('keeps a post whose likes are hidden', () => {
    // Hidden likes drop a post from the SECONDARY outcome only. Dropping it
    // here would shrink the PRIMARY's N for a reason the primary does not have.
    const plan = planIngest({ videos: [video({ likes: null })], runAt: RUN_AT });
    expect(plan.posts).toHaveLength(1);
    expect(plan.snapshots[0]!.likes).toBeNull();
  });

  test('keeps a post with very few views', () => {
    // A view-count floor applied to a views label is selection on the outcome
    // variable — the exact flaw that disqualifies Instagram's top_media (§2).
    const plan = planIngest({ videos: [video({ views: 3 })], runAt: RUN_AT });
    expect(plan.posts).toHaveLength(1);
    expect(plan.snapshots[0]!.views).toBe(3);
  });
});

describe('snapshots', () => {
  test('stamps every snapshot with the run timestamp, not the wall clock', () => {
    // `@@unique([postId, capturedAt])` is what makes an at-least-once retry a
    // no-op rather than a duplicate row. That only holds if a re-run of the
    // SAME job produces the SAME capturedAt — so it comes from the job, never
    // from `new Date()`.
    const plan = planIngest({ videos: [video()], runAt: RUN_AT });
    expect(plan.snapshots).toHaveLength(1);
    expect(plan.snapshots[0]!.capturedAt.toISOString()).toBe(RUN_AT.toISOString());
  });

  test('emits one snapshot per included post and none for excluded ones', () => {
    const plan = planIngest({ videos: fixtureVideos, runAt: RUN_AT });
    expect(plan.snapshots.map((s) => s.platformVideoId)).toEqual(
      plan.posts.map((p) => p.platformVideoId),
    );
  });
});
