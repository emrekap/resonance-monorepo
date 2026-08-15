import { describe, expect, test } from 'bun:test';

import { stimulusColumns } from './stimulus';

/**
 * The three `stimulus_has_*` columns drive which timeline lines the result
 * screen fades. The distinction that matters throughout: **null means
 * "unknown", never "no"** — a legacy payload (no probe, no transcript) must
 * render exactly as it did before these columns existed, which is what the
 * mobile client does for null.
 */
describe('stimulusColumns', () => {
  const transcript = (...texts: string[]) =>
    texts.map((text, index) => ({ startSec: index, text }));

  test('passes the probe flags through', () => {
    const columns = stimulusColumns({
      stimulus: { hasAudio: false, hasVisual: true },
      transcript: transcript('hello'),
    });
    expect(columns.stimulusHasAudio).toBe(false);
    expect(columns.stimulusHasVisual).toBe(true);
  });

  test('derives speech from the transcript, not from the probe', () => {
    // The probe cannot hear *speech* — whisperx already did. A tone-only clip
    // has audio but no speech.
    const columns = stimulusColumns({
      stimulus: { hasAudio: true, hasVisual: true },
      transcript: transcript('', '', ''),
    });
    expect(columns.stimulusHasAudio).toBe(true);
    expect(columns.stimulusHasSpeech).toBe(false);
  });

  test('whitespace-only segments are not speech', () => {
    const columns = stimulusColumns({ stimulus: null, transcript: transcript('  ', '\n') });
    expect(columns.stimulusHasSpeech).toBe(false);
  });

  test('one spoken word anywhere makes it speech', () => {
    const columns = stimulusColumns({ stimulus: null, transcript: transcript('', 'ok', '') });
    expect(columns.stimulusHasSpeech).toBe(true);
  });

  test('a payload from before the probe existed stays unknown, not false', () => {
    const columns = stimulusColumns({ stimulus: null, transcript: null });
    expect(columns).toEqual({
      stimulusHasAudio: null,
      stimulusHasVisual: null,
      stimulusHasSpeech: null,
    });
  });

  test('a half-failed probe keeps the half that answered', () => {
    const columns = stimulusColumns({
      stimulus: { hasAudio: false, hasVisual: null },
      transcript: null,
    });
    expect(columns.stimulusHasAudio).toBe(false);
    expect(columns.stimulusHasVisual).toBeNull();
  });
});
