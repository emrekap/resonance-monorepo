import { describe, expect, test } from 'bun:test';

import { deriveMarkers, mutedBands } from './timeline-math';

/**
 * The muting rules, tested at the pure seam (the component itself needs a
 * native renderer). Two invariants:
 *
 * - a muted band must not place the peak/dip markers — a silent clip's
 *   auditory noise could otherwise put the green "peak" line on a moment
 *   nothing actually happens in;
 * - null stimulus flags mean **unknown**, and unknown renders exactly like a
 *   row from before the flags existed: nothing muted.
 */

const timeline = {
  startSec: [0, 1, 2, 3],
  visual: [0, 1, 0, 0],
  audio: [0, 0, 0, 5],
  language: [0, 0, -3, 0],
};

const LIVE = { visual: false, audio: false, language: false };

describe('deriveMarkers', () => {
  test('peak and dip come from the combined curve', () => {
    const markers = deriveMarkers(timeline, LIVE);
    expect(markers).toEqual([
      { kind: 'dip', startSec: 2 },
      { kind: 'peak', startSec: 3 },
    ]);
  });

  test('a muted band cannot place a marker', () => {
    // Audio holds the global max; muting it must move the peak to visual's.
    const markers = deriveMarkers(timeline, { ...LIVE, audio: true });
    expect(markers).toContainEqual({ kind: 'peak', startSec: 1 });
    expect(markers).not.toContainEqual({ kind: 'peak', startSec: 3 });
  });

  test('all bands muted yields no markers at all', () => {
    const markers = deriveMarkers(timeline, { visual: true, audio: true, language: true });
    expect(markers).toEqual([]);
  });

  test('fewer than three points yields no markers', () => {
    const short = {
      startSec: [0, 1],
      visual: [0, 1],
      audio: [0, 0],
      language: [0, 0],
    };
    expect(deriveMarkers(short, LIVE)).toEqual([]);
  });
});

describe('mutedBands', () => {
  test('an explicit false mutes the matching line', () => {
    expect(
      mutedBands({
        stimulusHasAudio: false,
        stimulusHasVisual: true,
        stimulusHasSpeech: false,
      }),
    ).toEqual({ visual: false, audio: true, language: true });
  });

  test('null flags mute nothing — unknown is not "no"', () => {
    expect(
      mutedBands({
        stimulusHasAudio: null,
        stimulusHasVisual: null,
        stimulusHasSpeech: null,
      }),
    ).toEqual({ visual: false, audio: false, language: false });
  });

  test('a missing result mutes nothing', () => {
    expect(mutedBands(null)).toEqual({ visual: false, audio: false, language: false });
  });

  test('speech drives the language line, audio drives the audio line', () => {
    // A music-only clip: audio present, nothing spoken.
    expect(
      mutedBands({
        stimulusHasAudio: true,
        stimulusHasVisual: true,
        stimulusHasSpeech: false,
      }),
    ).toEqual({ visual: false, audio: false, language: true });
  });
});
