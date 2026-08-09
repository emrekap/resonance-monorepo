import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Timeline, TranscriptEntry } from '@repo/queue';
import { RecommendationKind } from '@repo/db/enums';
import type { AxisRow } from './scoring';

/**
 * The one non-deterministic step in the pipeline: turning numbers into advice.
 *
 * Claude is given the scores, the curves, the *already-located* peaks and dips,
 * and the transcript, and asked to write `analysis_recommendations`. It computes
 * nothing. That split is what makes the output checkable — a hallucinated
 * timestamp is caught by comparing it against the curve, whereas a hallucinated
 * score would be caught by nothing and would read as real.
 *
 * Everything the model returns is treated as untrusted input: parsed, range
 * checked against the clip's own duration, truncated, capped, and re-prioritised
 * from array order. `priority` in particular is never read from the model — it
 * orders the list a creator reads top-to-bottom, and there is no reason to let
 * generated text decide that.
 */

/** Room for thinking plus a short JSON object; this task needs nowhere near it. */
const MAX_TOKENS = 16_000;
const MAX_RECOMMENDATIONS = 4;
const MAX_MESSAGE_CHARS = 200;
/** The curve is for reading trends, not for reconstruction — stride it down. */
const MAX_CURVE_POINTS = 40;

/**
 * POSTING_TIME is deliberately absent from the enum the model may choose from.
 * The value exists on `recommendation_kind_enum`, but nothing in this pipeline
 * knows anything about when a creator posts, and an available enum value is an
 * invitation to guess.
 */
const OFFERED_KINDS = [
  RecommendationKind.HOOK,
  RecommendationKind.PACING,
  RecommendationKind.TRIM,
  RecommendationKind.AUDIO,
  RecommendationKind.CLARITY,
  RecommendationKind.LENGTH,
  RecommendationKind.CAPTION,
] as const;

const responseSchema = z.object({
  recommendations: z
    .array(
      z.object({
        kind: z.enum(OFFERED_KINDS),
        message: z.string().min(1),
        targetStartSec: z.number().nullish(),
        targetStopSec: z.number().nullish(),
      }),
    )
    .max(50), // generous — the real cap is applied after validation
});

/**
 * What the model is allowed to return, before validation.
 *
 * Exported so tests can construct it: the `kind` union here is deliberately
 * narrower than `RecommendationKind`, which is what stops POSTING_TIME reaching
 * the database through a code path rather than only through the prompt.
 */
export type ModelRecommendations = z.infer<typeof responseSchema>;

export type Recommendation = {
  kind: RecommendationKind;
  message: string;
  targetStartSec: number | null;
  targetStopSec: number | null;
  priority: number;
};

export type InsightInput = {
  /** `video` / `audio` / `image` — the creator's word for it, not the model's. */
  modality: string;
  durationSec: number;
  timeline: Timeline;
  transcript: readonly TranscriptEntry[];
  axisRows: readonly AxisRow[];
  percentileInChannel: number | null;
};

/** A notable moment in the attention curve, located in code and explained by Claude. */
type Marker = { kind: 'peak' | 'dip'; startSec: number; value: number };

/**
 * The two strongest peaks and two deepest dips in the attention curve.
 *
 * Located here rather than asked for: finding an extremum is arithmetic, and the
 * timestamps a creator is told to trim have to be right. Markers are spaced at
 * least `minGapSec` apart so a single broad dip does not consume all four slots.
 */
export function findMarkers(timeline: Timeline, minGapSec = 1): Marker[] {
  const { startSec, attention } = timeline;
  const points = startSec
    .map((sec, index) => ({ startSec: sec, value: attention[index] ?? 0 }))
    .filter((point) => Number.isFinite(point.value));
  if (points.length < 2) return [];

  const pick = (kind: 'peak' | 'dip'): Marker[] => {
    const ordered = [...points].sort((a, b) =>
      kind === 'peak' ? b.value - a.value : a.value - b.value,
    );
    const chosen: Marker[] = [];
    for (const point of ordered) {
      if (chosen.length === 2) break;
      if (chosen.every((taken) => Math.abs(taken.startSec - point.startSec) >= minGapSec)) {
        chosen.push({ kind, startSec: point.startSec, value: point.value });
      }
    }
    return chosen;
  };

  return [...pick('peak'), ...pick('dip')].sort((a, b) => a.startSec - b.startSec);
}

/** Uniform stride down to at most `limit` points, always keeping the last one. */
function downsample<T>(values: readonly T[], limit = MAX_CURVE_POINTS): T[] {
  if (values.length <= limit) return [...values];
  const stride = Math.ceil(values.length / limit);
  const sampled = values.filter((_, index) => index % stride === 0);
  const last = values[values.length - 1] as T;
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

const SYSTEM_PROMPT = `You write short, specific coaching notes for creators about a video or audio clip they just analysed.

You are given the output of a brain-encoding model (TRIBE), which predicts cortical response to the clip second by second. You will receive per-second curves for visual, audio and language networks, the moments where attention peaked and dropped, axis scores, and the transcript.

Rules:
- Every number and timestamp you are given is already correct. Never compute, estimate, or adjust one. Only reference moments that appear in the markers or the transcript you were given.
- Write to the creator, in second person, about their clip. Reference what actually happens in it — quote or paraphrase the transcript when it explains a moment.
- Never mention brains, cortex, networks, neural activity, fMRI, or the model. The creator cares what to change, not how you know.
- One concrete action per note. "Trim the pause at 0:03" beats "improve pacing".
- Set targetStartSec/targetStopSec when a note is about a specific moment; leave them null for notes about the whole clip.
- Between 2 and 4 notes. Fewer good notes beat four padded ones.
- Each message is one sentence, under 200 characters.
- An axis marked BETA is a weak signal — do not build a note on it alone.
- If the clip has no speech, do not write notes about wording, script or captions.`;

function buildPrompt(input: InsightInput): string {
  const { timeline, transcript, axisRows, durationSec, modality, percentileInChannel } = input;
  const time = (sec: number) =>
    `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  const starts = downsample(timeline.startSec);
  const curve = (name: string, values: readonly number[] | null | undefined) =>
    values?.length
      ? `${name}: ${downsample(values)
          .map((value) => value.toFixed(2))
          .join(', ')}`
      : `${name}: unavailable`;

  const spoken = transcript.filter((entry) => entry.text.trim().length > 0);

  const axes = axisRows.length
    ? axisRows
        .map((row) => `- ${row.axis}: ${Math.round(row.score)}/100 (${row.confidence})`)
        .join('\n')
    : '- Not enough history in this workspace to rank the axes yet.';

  return [
    `Clip: ${modality}, ${durationSec.toFixed(1)}s long.`,
    percentileInChannel === null
      ? 'This creator has too few previous analyses to rank this clip against, so do not refer to how it compares to their other posts.'
      : `Ranks at the ${Math.round(percentileInChannel)}th percentile of this creator's own previous clips.`,
    '',
    "Axis scores (percentile against this creator's own history):",
    axes,
    '',
    `Timestamps for the curves below (seconds): ${starts.map((s) => s.toFixed(1)).join(', ')}`,
    curve('Visual', timeline.visual),
    curve('Audio', timeline.audio),
    curve('Language', timeline.language),
    '',
    'Notable moments (already located — use these timestamps exactly):',
    findMarkers(timeline)
      .map(
        (marker) => `- ${marker.kind} at ${time(marker.startSec)} (${marker.startSec.toFixed(1)}s)`,
      )
      .join('\n') || '- none detected',
    '',
    spoken.length
      ? `Transcript:\n${spoken.map((entry) => `[${time(entry.startSec)}] ${entry.text}`).join('\n')}`
      : 'Transcript: this clip contains no speech.',
  ].join('\n');
}

/**
 * Drop anything the model got wrong, then impose our own ordering.
 *
 * Exported so the validation can be tested without a network call — it is the
 * part that has to hold when the model misbehaves.
 */
export function validate(raw: ModelRecommendations, durationSec: number): Recommendation[] {
  const seen = new Set<string>();

  return raw.recommendations
    .map((item) => {
      // A timestamp outside the clip cannot be scrubbed to and cannot be acted
      // on, so the note keeps its text and loses its (wrong) anchor rather than
      // sending a creator to a moment that does not exist.
      const inClip = (value: number | null | undefined): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= durationSec
          ? value
          : null;

      let start = inClip(item.targetStartSec);
      let stop = inClip(item.targetStopSec);
      if (start !== null && stop !== null && start > stop) [start, stop] = [stop, start];

      return {
        kind: item.kind,
        message: item.message.trim().slice(0, MAX_MESSAGE_CHARS),
        targetStartSec: start,
        targetStopSec: stop,
        priority: 0,
      };
    })
    .filter((item) => {
      if (item.message.length === 0) return false;
      // Two TRIMs at different moments are both legitimate; two at the same
      // moment are the model repeating itself.
      const key = `${item.kind}:${item.targetStartSec ?? 'none'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RECOMMENDATIONS)
    .map((item, index) => ({ ...item, priority: index }));
}

let client: Anthropic | null = null;

/** Whether the insight stage can run at all — checked once at boot, not per job. */
export function insightsEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Ask Claude for recommendations.
 *
 * **This throws on every failure.** `writeRecommendations` in `results.ts` is
 * what makes the stage best-effort, by catching and recording the reason on
 * `raw_stats.insights`. Swallowing here instead would return `[]`, which is
 * indistinguishable from a model that had nothing to say — and a missing tips
 * section nobody can explain is worse than one that names its cause.
 *
 * What must not happen is an exception reaching BullMQ: that retries the whole
 * handler, re-billing this call and burning attempts that exist for real
 * failures, because a copywriting request had a bad minute. The analysis is
 * already committed SUCCEEDED with its score, timeline and axes; tips are the
 * one part of the screen allowed to be missing. **Any new call site needs the
 * same try/catch.**
 */
export async function generateRecommendations(
  input: InsightInput,
  deps: { anthropic?: Anthropic } = {},
): Promise<Recommendation[]> {
  const anthropic = deps.anthropic ?? (client ??= new Anthropic());

  const response = await anthropic.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    // Opus 5 runs safety classifiers that can decline a request outright, and a
    // clip's transcript is arbitrary creator speech — nothing here controls what
    // it contains. `'default'` re-runs a declined request on Anthropic's
    // recommended substitute server-side, routed by refusal category, so the
    // usual outcome is tips from a slightly older model rather than no tips at
    // all. Named rather than pinned to a model so a deprecation is not a code
    // change here.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Structured outputs rather than a tool: there is nothing to execute, and
    // this constrains the shape without a parse-and-retry loop.
    //
    // Written out rather than derived with `zodOutputFormat(responseSchema)`,
    // which looks like the DRY-er option and is not: that helper lowers `enum`
    // and `minLength` into a *description string* rather than real JSON Schema
    // keywords. The enum is the whole reason POSTING_TIME cannot be returned —
    // as a description it becomes a suggestion the model may ignore, and the
    // violation only surfaces as a rejected response and an analysis with no
    // tips. `OFFERED_KINDS` is shared with the zod schema, so the one field most
    // likely to drift is defined once either way.
    output_config: {
      effort: 'medium',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: [...OFFERED_KINDS] },
                  message: { type: 'string' },
                  targetStartSec: { type: ['number', 'null'] },
                  targetStopSec: { type: ['number', 'null'] },
                },
                required: ['kind', 'message', 'targetStartSec', 'targetStopSec'],
                additionalProperties: false,
              },
            },
          },
          required: ['recommendations'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: buildPrompt(input) }],
  });

  // Both checked before touching `content`, because both return HTTP 200 with
  // content that is empty or partial — indexing into it blind throws something
  // unhelpful instead of saying what happened, and this message is what lands in
  // `raw_stats.insights` for whoever asks why a screen has no tips.
  if (response.stop_reason === 'refusal') {
    throw new Error(
      `model declined to answer (${response.stop_details?.category ?? 'unknown'}); ` +
        `served by ${response.model}`,
    );
  }
  // Thinking is on by default on Opus 5 and shares MAX_TOKENS with the reply, so
  // a long enough transcript can spend the budget before the JSON closes. The
  // parse below would fail on the truncated object anyway; naming the cause here
  // is the difference between "raise MAX_TOKENS" and an unexplained parse error.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`response truncated at max_tokens (${MAX_TOKENS}) before the JSON closed`);
  }

  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error('model returned no text block');

  // Parsed again on this side even though the schema constrained generation:
  // the schema shapes the output, it is not a guarantee we are entitled to skip
  // checking.
  return validate(responseSchema.parse(JSON.parse(text)), input.durationSec);
}
