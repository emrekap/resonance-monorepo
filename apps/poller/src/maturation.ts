import { prismaService } from '@repo/db';

/**
 * `N` — the age at which the label is read AND the age below which a post is
 * excluded (spec §5c).
 *
 * **One parameter serving two jobs, deliberately not two knobs.** If the
 * measurement age and the inclusion floor could drift apart, the corpus would
 * contain posts whose label was read before they qualified, and nothing would
 * flag it.
 *
 * Two phases:
 *
 *   1. days 1-28, before enough series exist — the hard-coded fallback, 14.
 *   2. day 29+, computed by SQL over `corpus.metric_snapshots`: the smallest
 *      age at which the median post's day-over-day view growth has flattened.
 *
 * The fallback is not a placeholder awaiting deletion. It stays as the value
 * used whenever the phase-2 query has insufficient data, so a fresh environment
 * is never blocked on four weeks of history.
 *
 * **The snapshot manifest records both the value and the phase.** Without that,
 * two runs at different floors are silently incomparable — the label itself
 * changed meaning between them — and a shifted parameter would show up as an
 * unexplainable movement in rho rather than a visible difference in the
 * artifact. Which is why `chooseMaturation` reports phase 1 whenever it returns
 * the fallback, even at a corpus age where phase 2 was eligible: the phase
 * describes where the NUMBER came from, not what the calendar allowed.
 */

export const FALLBACK_N_DAYS = 14;

/** Phase 2 becomes eligible once the corpus is old enough to have series. */
export const PHASE2_MIN_CORPUS_AGE_DAYS = 29;

/** Below this many post-days at an age, its median is noise. */
export const PHASE2_MIN_OBSERVATIONS = 30;

/** Day-over-day relative view gain under which growth counts as flattened. */
export const PHASE2_GAIN_THRESHOLD = 0.02;

/**
 * Ages searched. The floor of 7 keeps `N` from landing inside the first-week
 * surge even if a quiet cohort flattens early; the ceiling of 28 keeps the
 * inclusion floor from swallowing most of the corpus.
 */
export const PHASE2_AGE_RANGE = { min: 7, max: 28 } as const;

export interface GainByAge {
  ageDays: number;
  medianGain: number;
  observations: number;
}

export interface Maturation {
  nDays: number;
  phase: 1 | 2;
}

export function chooseMaturation(input: { corpusAgeDays: number; gains: GainByAge[] }): Maturation {
  if (input.corpusAgeDays < PHASE2_MIN_CORPUS_AGE_DAYS) {
    return { nDays: FALLBACK_N_DAYS, phase: 1 };
  }

  const flattened = input.gains
    .filter(
      (g) =>
        g.observations >= PHASE2_MIN_OBSERVATIONS &&
        g.ageDays >= PHASE2_AGE_RANGE.min &&
        g.ageDays <= PHASE2_AGE_RANGE.max &&
        g.medianGain < PHASE2_GAIN_THRESHOLD,
    )
    .map((g) => g.ageDays)
    .sort((a, b) => a - b);

  const smallest = flattened[0];
  if (smallest === undefined) return { nDays: FALLBACK_N_DAYS, phase: 1 };
  return { nDays: smallest, phase: 2 };
}

/**
 * Median day-over-day relative view gain, by post age.
 *
 * One row per post-day rather than per snapshot: two polls on the same UTC day
 * (a retry, a manual run) would otherwise contribute a spurious zero-gain step.
 */
export const MEDIAN_GAIN_BY_AGE_SQL = `
  with daily as (
    select s.post_id,
           floor(extract(epoch from (s.captured_at - p.published_at)) / 86400)::int as age_days,
           max(s.views) as views
    from corpus.metric_snapshots s
    join corpus.posts p on p.id = s.post_id
    where s.views is not null
    group by 1, 2
  ),
  stepped as (
    select age_days,
           views,
           lag(views) over (partition by post_id order by age_days) as previous
    from daily
  )
  select age_days,
         percentile_cont(0.5) within group (
           order by (views - previous)::float8 / previous
         ) as median_gain,
         count(*) as observations
  from stepped
  where previous is not null and previous > 0
  group by age_days
  order by age_days
`;

/** Corpus age is the age of its oldest observation, not of its oldest post. */
const CORPUS_AGE_SQL = `
  select coalesce(
    floor(extract(epoch from (now() - min(captured_at))) / 86400)::int, 0
  ) as age_days
  from corpus.metric_snapshots
`;

export async function readMaturation(): Promise<Maturation> {
  const [[age], gains] = await Promise.all([
    prismaService.$queryRawUnsafe<{ age_days: number }[]>(CORPUS_AGE_SQL),
    prismaService.$queryRawUnsafe<
      { age_days: number; median_gain: number | null; observations: bigint }[]
    >(MEDIAN_GAIN_BY_AGE_SQL),
  ]);

  return chooseMaturation({
    corpusAgeDays: age?.age_days ?? 0,
    gains: gains
      .filter((row) => row.median_gain !== null)
      .map((row) => ({
        ageDays: row.age_days,
        medianGain: row.median_gain!,
        // `count(*)` is a bigint, which the driver hands back as BigInt.
        observations: Number(row.observations),
      })),
  });
}
