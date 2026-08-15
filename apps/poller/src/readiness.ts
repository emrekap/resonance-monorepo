import { prismaService, type PrismaClient } from '@repo/db';

import type { Maturation } from './maturation.ts';

/**
 * The weekly corpus-readiness report (spec §12.2).
 *
 * This exists so the deferred §7 decision — which source-file acquisition route
 * to take, if any — arrives as a **standing number somebody is already looking
 * at**, rather than a question that has to be remembered. `status.license` is
 * captured on the `videos.list` call already being made, at no extra quota, so
 * "do enough channels have >=20 Creative-Commons clips under 30 s?" is a SQL
 * query against the corpus rather than a separate research exercise. Whichever
 * route is eventually chosen, no re-crawl is needed.
 *
 * It also states the maturation parameter and its phase, the exclusion tallies
 * by reason, and how many channels clear the >=20-post floor — the four numbers
 * that say whether the corpus is worth extracting yet.
 */

/** The prereg's per-creator floor. */
export const MIN_POSTS_PER_CHANNEL = 20;

export interface ChannelReadiness {
  platformChannelId: string;
  title: string | null;
  niche: string | null;
  posts: number;
  /** Posts under 30 s whose `license` is `creativeCommon`. */
  ccbyUnder30s: number;
  /** Posts old enough for the current `N` — the ones that have a label today. */
  maturePosts: number;
}

export interface Readiness {
  generatedAt: Date;
  maturation: Maturation;
  channels: ChannelReadiness[];
  exclusions: Record<string, number>;
  totals: {
    channels: number;
    posts: number;
    clearingFloor: number;
    ccbyClearingFloor: number;
  };
}

export function summarise(input: {
  generatedAt: Date;
  maturation: Maturation;
  channels: ChannelReadiness[];
  exclusions: Record<string, number>;
}): Readiness {
  return {
    ...input,
    totals: {
      channels: input.channels.length,
      posts: input.channels.reduce((total, c) => total + c.posts, 0),
      clearingFloor: input.channels.filter((c) => c.posts >= MIN_POSTS_PER_CHANNEL).length,
      // Deliberately a separate count, not a filter of the previous one: a
      // channel can clear the post floor and hold almost no CC-BY clips, and
      // conflating the two would answer §7 with the wrong number.
      ccbyClearingFloor: input.channels.filter((c) => c.ccbyUnder30s >= MIN_POSTS_PER_CHANNEL)
        .length,
    },
  };
}

export function renderReadiness(readiness: Readiness): string {
  const day = readiness.generatedAt.toISOString().slice(0, 10);
  const { totals, maturation } = readiness;

  const lines = [
    `# Corpus readiness — ${day}`,
    '',
    `Maturation: **N = ${maturation.nDays} days** (phase ${maturation.phase}). ` +
      'Two runs at different floors are not comparable — the label changed meaning ' +
      'between them — so the phase is stated beside the value, always.',
    '',
    `Frame: **${totals.channels} channels · ${totals.posts} posts**.`,
    `Clearing the >=${MIN_POSTS_PER_CHANNEL}-post floor: ` +
      `**${totals.clearingFloor} / ${totals.channels} channels**.`,
    `Clearing it in Creative-Commons clips under 30 s: ` +
      `**${totals.ccbyClearingFloor} / ${totals.channels} channels** — this is the ` +
      'number the deferred source-file decision (spec §7) turns on.',
    '',
    '## Per channel',
    '',
    '| Channel | Niche | Posts | Mature | CC-BY <=30s |',
    '| ------- | ----- | ----- | ------ | ----------- |',
    ...readiness.channels.map(
      (c) =>
        `| ${c.title ?? c.platformChannelId} | ${c.niche ?? '—'} | ${c.posts} | ` +
        `${c.maturePosts} | ${c.ccbyUnder30s} |`,
    ),
    '',
    '## Exclusions, by reason',
    '',
    '| Reason | Count |',
    '| ------ | ----- |',
    ...Object.entries(readiness.exclusions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `| ${reason} | ${count} |`),
    '',
    'Exclusions are counted at ingest and are the frame definition only ' +
      '(public, dated, <=30 s). Age, hidden likes and the secondary outcome’s ' +
      'denominator floor are applied per-outcome at extract time — see spec §5b.',
    '',
  ];

  return lines.join('\n');
}

export async function buildReadiness(input: {
  now: Date;
  maturation: Maturation;
  db?: PrismaClient;
}): Promise<Readiness> {
  const db = input.db ?? prismaService;
  const matureBefore = new Date(input.now.getTime() - input.maturation.nDays * 86_400_000);

  const channels = await db.corpusChannel.findMany({
    select: {
      platformChannelId: true,
      title: true,
      niche: true,
      posts: { select: { license: true, publishedAt: true } },
    },
    orderBy: { platformChannelId: 'asc' },
  });

  const runs = await db.corpusPollRun.findMany({
    where: { runAt: { gte: new Date(input.now.getTime() - 7 * 86_400_000) } },
    select: { excluded: true },
  });

  const exclusions: Record<string, number> = {};
  for (const run of runs) {
    for (const [reason, count] of Object.entries(run.excluded as Record<string, number>)) {
      exclusions[reason] = (exclusions[reason] ?? 0) + count;
    }
  }

  return summarise({
    generatedAt: input.now,
    maturation: input.maturation,
    channels: channels.map((channel) => ({
      platformChannelId: channel.platformChannelId,
      title: channel.title,
      niche: channel.niche,
      posts: channel.posts.length,
      // Every stored post is already <=30 s — that is the frame's definition,
      // applied at ingest — so the licence is the only extra predicate here.
      ccbyUnder30s: channel.posts.filter((post) => post.license === 'creativeCommon').length,
      maturePosts: channel.posts.filter((post) => post.publishedAt <= matureBefore).length,
    })),
    exclusions,
  });
}
