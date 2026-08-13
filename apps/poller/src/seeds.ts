import { z } from 'zod';

/**
 * The sampling frame — hand-curated and committed, never discovered.
 *
 * Two reasons (spec §5d). Reproducibility and zero discovery quota are the
 * cheap ones; the real one is that curation checks a property no automated
 * discovery can: **a channel whose Shorts all perform identically contributes
 * nothing**, because there is no variance to rank. "Here is our frame and why
 * each channel is in it" is also a materially stronger answer under diligence
 * than "search returned these".
 */

/** `UC` + 22 base64url characters. A handle or a video id is not one. */
export const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

const seedChannelSchema = z.object({
  id: z.string().regex(CHANNEL_ID_PATTERN, 'not a YouTube channelId (UC + 22 characters)'),
  handle: z.string().nullish().default(null),
  niche: z.string().min(1),
  /** Subscriber tier, so the frame's spread across audience size is auditable. */
  tier: z.enum(['nano', 'micro', 'mid', 'large']),
  /**
   * Why this channel is in the frame. The 40-character floor is not style: the
   * frame is only defensible if each line is a real reason, and a schema that
   * accepts "good channel" makes §5d's requirement decorative.
   */
  rationale: z.string().min(40, 'give a real one-line reason — see spec §5d'),
});

export type SeedChannel = z.infer<typeof seedChannelSchema>;

const seedFileSchema = z.object({
  version: z.literal(1),
  channels: z
    .array(seedChannelSchema)
    .min(1, 'the sampling frame is empty — curate apps/poller/seeds/channels.yaml (spec §5d)'),
});

/** Parse and validate a frame. Throws rather than returning a partial frame. */
export function parseSeeds(source: string): SeedChannel[] {
  const parsed = seedFileSchema.parse(Bun.YAML.parse(source));

  const seen = new Set<string>();
  for (const channel of parsed.channels) {
    if (seen.has(channel.id)) {
      throw new Error(`duplicate channel in the frame: ${channel.id}`);
    }
    seen.add(channel.id);
  }
  return parsed.channels;
}

export const SEEDS_PATH = new URL('../seeds/channels.yaml', import.meta.url).pathname;

export async function loadSeeds(path: string = SEEDS_PATH): Promise<SeedChannel[]> {
  return parseSeeds(await Bun.file(path).text());
}
