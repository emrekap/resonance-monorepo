import { describe, expect, test } from 'bun:test';

import channelsFixture from './__fixtures__/youtube/channels.json';
import playlistItemsFixture from './__fixtures__/youtube/playlist-items.json';
import videosFixture from './__fixtures__/youtube/videos.json';
import { VIDEOS_BATCH, createYouTubeClient } from './youtube.ts';

/** Answers with `body`, without touching the network. */
const respond = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

/** Records every URL asked for and answers from the fixtures. No network. */
function fakeFetch(calls: URL[] = []) {
  // `string | URL | Request`, not the DOM's `RequestInfo`: this package is
  // typed against `@types/bun` with `lib: ESNext`, so the DOM alias does not
  // exist here even though `bun test` runs the file happily without it.
  const impl = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    const body = url.pathname.endsWith('/channels')
      ? channelsFixture
      : url.pathname.endsWith('/playlistItems')
        ? { ...playlistItemsFixture, nextPageToken: undefined }
        : videosFixture;
    return respond(body);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * The rejection of `work`, or a failure saying it did not reject.
 *
 * bun-types declares `expect(...).rejects` as `Matchers<unknown>` — a *sync*
 * matcher — so `await expect(...).rejects.toThrow()` trips
 * `@typescript-eslint/await-thenable` even though it does return a promise at
 * runtime. Catching the rejection is honest about that and needs no suppression.
 */
function failureOf(work: Promise<unknown>): Promise<Error> {
  return work.then(
    () => {
      throw new Error('expected the call to fail, but it resolved');
    },
    (error: unknown) => error as Error,
  );
}

const client = (calls: URL[] = []) =>
  createYouTubeClient({ apiKey: 'test-key', fetch: fakeFetch(calls).impl });

describe('channels', () => {
  test('returns the uploads playlist and subscriber count', async () => {
    const [first] = await client().channels(['UCabcdefghijklmnopqrstuv']);
    expect(first!.uploadsPlaylistId).toBe('UUabcdefghijklmnopqrstuv');
    expect(first!.subscriberCount).toBe(184000);
    expect(first!.title).toBe('Example Kitchen');
  });

  test('reports a hidden subscriber count as null, not zero', async () => {
    // Zero would enter the B1 rung as a real follower count of zero and make a
    // mid-tier channel look like a brand new one.
    const [, second] = await client().channels(['UChiddensubscribersxxxxx']);
    expect(second!.subscriberCount).toBeNull();
  });
});

describe('uploads', () => {
  test('walks the uploads playlist and returns video ids', async () => {
    const calls: URL[] = [];
    const ids = await client(calls).uploads('UUabcdefghijklmnopqrstuv', 40);
    expect(ids).toEqual(['vid00000001', 'vid00000002', 'vid00000003']);
    expect(calls[0]!.pathname).toEndWith('/playlistItems');
    // 1 quota unit per call, versus 100 for search.list — see spec §5a.
    expect(calls[0]!.searchParams.get('part')).toBe('contentDetails');
  });

  test('stops at the requested limit', async () => {
    const ids = await client().uploads('UUabcdefghijklmnopqrstuv', 2);
    expect(ids).toHaveLength(2);
  });
});

describe('videos', () => {
  test('carries the raw duration, the licence and the counts', async () => {
    const [first] = await client().videos(['vid00000001']);
    expect(first!.duration).toBe('PT29S');
    // status.license rides along on a call already being made, at no extra
    // quota — which is what makes §7's deferral nearly free.
    expect(first!.license).toBe('creativeCommon');
    expect(first!.views).toBe(184203);
    expect(first!.likes).toBe(9120);
  });

  test('reports a hidden like count as null, not zero', async () => {
    // Zero would enter the SECONDARY outcome's numerator as a real zero.
    const [, second] = await client().videos(['vid00000002']);
    expect(second!.likes).toBeNull();
    expect(second!.views).toBe(5120);
  });

  test('asks for every part the corpus needs, in one call', async () => {
    const calls: URL[] = [];
    await client(calls).videos(['vid00000001']);
    expect(calls[0]!.searchParams.get('part')).toBe('snippet,contentDetails,statistics,status');
  });

  test('batches ids 50 at a time', async () => {
    const calls: URL[] = [];
    const ids = Array.from({ length: VIDEOS_BATCH + 1 }, (_, i) => `vid${i}`);
    await client(calls).videos(ids);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.searchParams.get('id')!.split(',')).toHaveLength(VIDEOS_BATCH);
    expect(calls[1]!.searchParams.get('id')!.split(',')).toHaveLength(1);
  });

  test('never sends the api key in a header, and never in the log', async () => {
    const calls: URL[] = [];
    await client(calls).videos(['vid00000001']);
    expect(calls[0]!.searchParams.get('key')).toBe('test-key');
  });
});

describe('errors', () => {
  test('raises with the status so a 403 quota error is legible', async () => {
    const failing = createYouTubeClient({
      apiKey: 'test-key',
      fetch: (() =>
        respond({ error: { message: 'quotaExceeded' } }, 403)) as unknown as typeof fetch,
    });
    const failure = await failureOf(failing.videos(['vid00000001']));
    expect(failure.message).toMatch(/403/);
  });

  test('keeps the api key out of the failure message', async () => {
    // `get` omits the URL from the error on purpose, because the URL carries
    // the key — and a failure message is exactly what gets pasted into an
    // issue. Nothing asserted it: the test named for the key only checks that
    // it IS in the query string.
    const failing = createYouTubeClient({
      apiKey: 'super-secret-key',
      fetch: (() =>
        respond({ error: { message: 'quotaExceeded' } }, 403)) as unknown as typeof fetch,
    });
    const failure = await failureOf(failing.videos(['vid00000001']));
    expect(failure.message).not.toContain('super-secret-key');
  });
});
