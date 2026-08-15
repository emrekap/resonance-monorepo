import { describe, expect, test } from 'bun:test';
import type { CorpusJob } from '@repo/queue';

import {
  backfillClips,
  nullSourceResolver,
  sourceResolver,
  type ClipStore,
  type CorpusPostRef,
  type ResolvedClip,
  type SourceResolver,
} from './source-resolver.ts';

const post = (id: string, license: string | null = 'creativeCommon'): CorpusPostRef => ({
  id,
  platformVideoId: `vid-${id}`,
  durationSec: 20,
  license,
});

// The fakes answer with `Promise.resolve` rather than `async`: nothing here
// awaits, and `@typescript-eslint/require-await` rejects an async function
// whose body never awaits and does not return a thenable.
function fakeStore(existing: string[] = []) {
  const recorded: { postId: string; clip: ResolvedClip }[] = [];
  const store: ClipStore = {
    hasClip(postId) {
      return Promise.resolve(existing.includes(postId));
    },
    recordClip(postId, clip) {
      recorded.push({ postId, clip });
      return Promise.resolve({ id: `clip-${postId}` });
    },
  };
  return { store, recorded };
}

const resolving: SourceResolver = {
  resolve(p) {
    return Promise.resolve({
      storageKey: `corpus/${p.platformVideoId}.mp4`,
      checksumSha256: 'a'.repeat(64),
      durationSec: p.durationSec,
      acquisitionRoute: 'creator_upload',
      url: `https://storage.test/${p.platformVideoId}.mp4`,
    });
  },
};

const collect = (jobs: CorpusJob[]) => (job: CorpusJob) => {
  jobs.push(job);
  return Promise.resolve();
};

describe('the default resolver', () => {
  test('resolves nothing, including for a Creative-Commons post', async () => {
    // A CC-BY licence resolves the COPYRIGHT question — the uploader has
    // granted reuse, including commercial, with attribution. It does NOT
    // resolve the ToS question: YouTube's terms still bar access by
    // unauthorised means. Those two halves are routinely conflated and are not
    // conflated here, which is why the default resolver returns nothing even
    // when the licence looks permissive.
    expect(await nullSourceResolver.resolve(post('a'))).toBeNull();
  });

  test('is what `sourceResolver()` selects today', () => {
    expect(sourceResolver()).toBe(nullSourceResolver);
    expect(sourceResolver('none')).toBe(nullSourceResolver);
  });

  test('refuses an unknown resolver rather than silently resolving nothing', () => {
    // Otherwise a typo in CORPUS_SOURCE_RESOLVER looks exactly like the
    // deferred state, and a backfill that acquires nothing looks healthy.
    expect(() => sourceResolver('creator-uploads')).toThrow(/unknown/i);
  });
});

describe('backfillClips', () => {
  test('enqueues nothing while the resolver resolves nothing', async () => {
    const { store, recorded } = fakeStore();
    const jobs: CorpusJob[] = [];
    const result = await backfillClips({
      posts: [post('a'), post('b')],
      resolver: nullSourceResolver,
      store,
      enqueue: collect(jobs),
    });

    expect(result).toEqual({ resolved: 0, enqueued: 0, skipped: 0 });
    expect(recorded).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  test('records the clip before enqueueing, so the job always has a row to point at', async () => {
    const { store, recorded } = fakeStore();
    const jobs: CorpusJob[] = [];
    const result = await backfillClips({
      posts: [post('a')],
      resolver: resolving,
      store,
      enqueue: collect(jobs),
    });

    expect(result).toEqual({ resolved: 1, enqueued: 1, skipped: 0 });
    expect(recorded[0]!.clip.acquisitionRoute).toBe('creator_upload');
    expect(jobs[0]).toEqual({
      corpusPostId: 'a',
      clipId: 'clip-a',
      modality: 'video',
      media: { url: 'https://storage.test/vid-a.mp4' },
    });
  });

  test('skips a post that already has a clip', async () => {
    // Re-running the backfill must not re-acquire, re-store and re-score a clip
    // — that is GPU spend on a number the corpus already holds.
    const { store, recorded } = fakeStore(['a']);
    const jobs: CorpusJob[] = [];
    const result = await backfillClips({
      posts: [post('a'), post('b')],
      resolver: resolving,
      store,
      enqueue: collect(jobs),
    });

    expect(result).toEqual({ resolved: 1, enqueued: 1, skipped: 1 });
    expect(recorded.map((r) => r.postId)).toEqual(['b']);
  });
});
