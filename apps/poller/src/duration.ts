/**
 * ISO-8601 durations, as `contentDetails.duration` returns them.
 *
 * There is no `isShort` field on the Data API, and the common workaround —
 * probing whether `youtube.com/shorts/{id}` resolves without redirecting — is
 * unofficial and unnecessary, because the **<=30 s rule is stricter than the
 * Shorts boundary anyway** (spec §5b). Filtering on this official field yields a
 * homogeneous format and satisfies the validation spec's requirement not to mix
 * short-form with long-form.
 */

const PATTERN = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Seconds, or null when the string is not a duration this understands. */
export function parseIsoDuration(value: string | null): number | null {
  if (!value) return null;
  const match = PATTERN.exec(value);
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  // `P` alone, or `PT`, carries no components — not a duration of zero.
  if (!days && !hours && !minutes && !seconds) return null;

  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}
