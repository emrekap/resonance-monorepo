import { prismaService, type PrismaClient } from '@repo/db';

/**
 * The 30-day text sweep (spec §6).
 *
 * YouTube's derived-metrics policy splits retention three ways rather than
 * applying a flat 30 days:
 *
 *   * statistical metrics (views, likes, comments, subscriber counts) — 36 months
 *   * derived metrics (anything computed from them) — 36 months
 *   * everything else (titles, descriptions, channel names) — 30 days, refresh
 *     or delete
 *
 * So the training corpus — the numbers, and everything derived from them — is
 * retainable for three years, which is longer than this validation needs. Only
 * TEXT is on the short clock, and that is all this touches.
 *
 * The 36-month tier requires the use-case amendment to be accepted; until then
 * the corpus operates under the base 30-day policy. That is a form, not a
 * negotiation, and it gates nothing else — file it on day one.
 *
 * This is a BACKSTOP. The poller refreshes `textRefreshedAt` on every pass, so
 * in steady state nothing here matches; what it catches is rows the poller has
 * stopped reaching (a deleted video, a channel dropped from the frame).
 */

export const TEXT_RETENTION_DAYS = 30;

export function textCutoff(now: Date): Date {
  return new Date(now.getTime() - TEXT_RETENTION_DAYS * 86_400_000);
}

/**
 * A null `textRefreshedAt` is a row already swept, not a row overdue.
 *
 * The sweep nulls the timestamp along with the text, which is what stops it
 * rewriting every dead row on every run, forever.
 */
export function isTextExpired(textRefreshedAt: Date | null, now: Date): boolean {
  if (textRefreshedAt === null) return false;
  return textRefreshedAt < textCutoff(now);
}

export interface SweepStore {
  nullPostText(cutoff: Date): Promise<number>;
  nullChannelText(cutoff: Date): Promise<number>;
}

export function prismaSweepStore(db: PrismaClient = prismaService): SweepStore {
  return {
    async nullPostText(cutoff) {
      const { count } = await db.corpusPost.updateMany({
        where: { textRefreshedAt: { lt: cutoff } },
        data: { title: null, description: null, tags: [], textRefreshedAt: null },
      });
      return count;
    },
    async nullChannelText(cutoff) {
      const { count } = await db.corpusChannel.updateMany({
        where: { textRefreshedAt: { lt: cutoff } },
        data: { title: null, textRefreshedAt: null },
      });
      return count;
    },
  };
}

export async function sweepText(input: {
  now: Date;
  store: SweepStore;
}): Promise<{ posts: number; channels: number }> {
  const cutoff = textCutoff(input.now);
  return {
    posts: await input.store.nullPostText(cutoff),
    channels: await input.store.nullChannelText(cutoff),
  };
}
