import { describe, expect, test } from 'bun:test';

import fixture from './__fixtures__/corpus-succeeded.json';
import { corpusJobSchema, corpusSucceededSchema } from './contract.ts';

/**
 * The poller↔ml boundary, checked from the TypeScript side.
 *
 * `__fixtures__/corpus-succeeded.json` is produced by **Pydantic**
 * (`apps/ml/tests/test_corpus_contract.py` regenerates and diffs it), so this
 * is a real cross-language round trip — the same posture as the analysis pair,
 * for the same reason: the two halves are mirrored by hand and nothing but a
 * test notices when one moves.
 */
describe('corpus.succeeded — the Pydantic payload', () => {
  test('parses as emitted by apps/ml', () => {
    const parsed = corpusSucceededSchema.parse(fixture);
    expect(parsed.corpusPostId).toBe(fixture.corpusPostId);
    expect(parsed.timeline.startSec).toHaveLength(3);
  });

  test('requires the axis bands', () => {
    // Unlike the analysis contract, where a worker deployed ahead of the ml
    // image must not reject every job. A corpus score exists ONLY to produce a
    // composite, so bands that never arrived make the row worthless — fail at
    // the boundary rather than write a null the extract has to filter.
    const { axisBands: _dropped, ...withoutBands } = fixture;
    expect(() => corpusSucceededSchema.parse(withoutBands)).toThrow();
    expect(() => corpusSucceededSchema.parse({ ...fixture, axisBands: null })).toThrow();
  });

  test('accepts null for the fields Pydantic leaves unset', () => {
    const parsed = corpusSucceededSchema.parse({
      ...fixture,
      durationSec: null,
      transcript: null,
      device: null,
    });
    expect(parsed.transcript).toBeNull();
  });

  test('carries no analysisId and no workspaceId', () => {
    // A corpus row has no tenant. If either of these ever appears here, the
    // isolation in §3 has been breached somewhere upstream.
    expect(Object.keys(fixture)).not.toContain('analysisId');
    expect(Object.keys(fixture)).not.toContain('workspaceId');
  });
});

describe('the corpus job', () => {
  test('carries the post, the clip and where to fetch the bytes', () => {
    const job = corpusJobSchema.parse({
      corpusPostId: '0199a1f2-3b4c-7d5e-8f90-1a2b3c4d5e6f',
      clipId: '0199a1f2-3b4c-7d5e-8f90-1a2b3c4d5e70',
      modality: 'video',
      media: { url: 'https://example.test/clip.mp4' },
    });
    expect(job.clipId).toBeString();
  });

  test('rejects a job with no clip — there is nothing to infer over', () => {
    expect(() =>
      corpusJobSchema.parse({
        corpusPostId: '0199a1f2-3b4c-7d5e-8f90-1a2b3c4d5e6f',
        modality: 'video',
        media: { url: 'https://example.test/clip.mp4' },
      }),
    ).toThrow();
  });
});
