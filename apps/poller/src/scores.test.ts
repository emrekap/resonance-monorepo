import { describe, expect, test } from 'bun:test';
import { composite } from '@repo/scoring';
import { corpusSucceededSchema } from '@repo/queue';

import fixture from '../../../packages/queue/src/__fixtures__/corpus-succeeded.json';
import { scoreRow } from './scores.ts';

const result = corpusSucceededSchema.parse(fixture);

describe('scoreRow', () => {
  test('computes the composite with the SAME function the product ships', () => {
    // Not a re-implementation and not a copied constant: `@repo/scoring` is
    // imported by `apps/worker` too. If corpus features were reduced by
    // different code, the backtest would stop describing the product and
    // nothing else here would notice.
    expect(scoreRow(result).composite).toBe(composite(result.axisBands));
  });

  test('stores no percentile and no resonance score', () => {
    // Both rank against a WORKSPACE's prior analyses (spec §4c). A crawled
    // channel has no workspace, so the number would be undefined at best and
    // misleading at worst. The within-creator ranking happens at extract time,
    // where the comparison set is the creator's own posts — which is also the
    // statistically correct scope, so the two concerns agree.
    // Through `unknown`: `ScoreRow` has no index signature, which is itself the
    // point — the two fields below are absent from the type as well as the row.
    const row = scoreRow(result) as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty('percentileInChannel');
    expect(row).not.toHaveProperty('resonanceScore');
  });

  test('keeps the five timeline arrays as parallel columns', () => {
    const row = scoreRow(result);
    expect(row.timelineStartSec).toEqual(result.timeline.startSec);
    expect(row.timelineVisual).toEqual(result.timeline.visual!);
    expect(
      new Set([
        row.timelineStartSec.length,
        row.timelineAttention.length,
        row.timelineVisual.length,
        row.timelineAudio.length,
        row.timelineLanguage.length,
      ]).size,
    ).toBe(1);
  });

  test('rejects a ragged timeline instead of storing one', () => {
    // The corpus has no reason to accept a row whose curves disagree: a
    // truncation decision belongs in `apps/ml`, where the reason is known.
    const ragged = { ...result, timeline: { ...result.timeline, visual: [0.1] } };
    expect(() => scoreRow(ragged)).toThrow(/length/i);
  });

  test('carries the transcript through for the B2 rung', () => {
    // `research/` builds the text features from this — it is the only text the
    // extract has that is not on the 30-day clock.
    expect(scoreRow(result).transcript).toHaveLength(result.timeline.startSec.length);
  });
});
