import { useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Text } from '@/components/ui';
import { useTheme } from '@/design';

import {
  BANDS,
  deriveMarkers,
  buildPath,
  formatClock,
  type MutedBands,
  type TimelineBands,
} from './timeline-math';

/**
 * The attention timeline — the hero of the result screen.
 *
 * Three curves, not one. `docs/resonance-model-design.md` §1b is explicit that
 * the flat brain-wide average is the debunked signal; what carries information
 * is *which* network responded and when. So visual, audio and language are drawn
 * separately and a creator can see that their hook landed visually while the
 * audio stayed flat.
 *
 * Drawn with inline SVG rather than a charting library: it is four paths and two
 * markers, and `react-native-svg` is already a dependency. A chart library would
 * be a bundle and an API to fight for a shape this specific.
 *
 * A **muted** band (the clip does not contain that channel — a silent video's
 * audio line, a black screen's visual line) is still drawn, in the neutral band
 * colour at reduced opacity, with a note in the legend. Faded rather than
 * hidden: the model genuinely predicted the curve, but there is nothing in the
 * content behind it, and hiding it would raise "where did my audio line go?"
 * where fading answers the question. See `timeline-math.ts` for what mutes.
 */

// The deliberate omission of `attention` from TimelineBands, though the API
// returns one: that array is the brain-wide mean, and independent work
// (arXiv 2607.01400, cited in docs/resonance-model-design.md §0) shows it does
// *not* predict engagement — the signal is in specific networks. It stays in
// the database as telemetry; drawing it would put the one debunked curve on
// the hero chart.
export type { MutedBands, TimelineBands } from './timeline-math';
export { formatClock, mutedBands } from './timeline-math';

const NO_MUTING: MutedBands = { visual: false, audio: false, language: false };

export interface AttentionTimelineProps {
  timeline: TimelineBands;
  /** Which lines to fade — from `mutedBands(result)`. Defaults to none. */
  muted?: MutedBands;
  /** Highlighted moment, set when a recommendation row is tapped. */
  focusSec?: number | null;
  height?: number;
}

export function AttentionTimeline({
  timeline,
  muted = NO_MUTING,
  focusSec = null,
  height = 132,
}: AttentionTimelineProps) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const markers = useMemo(() => deriveMarkers(timeline, muted), [timeline, muted]);

  // Muted bands stay inside the shared y-domain: they are drawn, so they must
  // fit, and rescaling without them would quietly exaggerate the live lines.
  const domain = useMemo(() => {
    const all = [...timeline.visual, ...timeline.audio, ...timeline.language];
    if (all.length === 0) return { min: 0, max: 1 };
    const min = Math.min(...all);
    const max = Math.max(...all);
    // A perfectly flat clip would give a zero span and divide by ~0; pad it so
    // the line renders down the middle instead of at an edge.
    return max - min < 1e-6 ? { min: min - 0.5, max: max + 0.5 } : { min, max };
  }, [timeline]);

  // Muted lines first, so every live line draws on top of them.
  const drawOrder = useMemo(
    () => [...BANDS].sort((a, b) => Number(muted[b.key]) - Number(muted[a.key])),
    [muted],
  );

  const xs = timeline.startSec;
  const firstSec = xs[0] ?? 0;
  const lastSec = xs[xs.length - 1] ?? 0;
  const toX = (sec: number) =>
    ((Math.min(Math.max(sec, firstSec), lastSec) - firstSec) / Math.max(1e-6, lastSec - firstSec)) *
    width;

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return (
    <View style={{ gap: theme.space.sm }}>
      <View onLayout={onLayout} style={{ height }}>
        {width > 0 ? (
          <Svg width={width} height={height}>
            {markers.map((marker) => (
              <Line
                key={`${marker.kind}-${marker.startSec}`}
                x1={toX(marker.startSec)}
                y1={0}
                x2={toX(marker.startSec)}
                y2={height}
                stroke={marker.kind === 'peak' ? theme.colors.success : theme.colors.warning}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.55}
              />
            ))}

            {focusSec !== null ? (
              <Line
                x1={toX(focusSec)}
                y1={0}
                x2={toX(focusSec)}
                y2={height}
                stroke={theme.colors.text}
                strokeWidth={1.5}
                opacity={0.8}
              />
            ) : null}

            {drawOrder.map((band) => (
              <Path
                key={band.key}
                d={buildPath(timeline[band.key], xs, domain, width, height)}
                stroke={muted[band.key] ? theme.colors.bandNeutral : theme.colors[band.token]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                fill="none"
                opacity={muted[band.key] ? 0.45 : 1}
              />
            ))}
          </Svg>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="caption" tone="muted">
          {formatClock(firstSec)}
        </Text>
        <Text variant="caption" tone="muted">
          {formatClock(lastSec)}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md }}>
        {BANDS.map((band) => (
          <View
            key={band.key}
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xs }}
          >
            <Svg width={10} height={10}>
              <Circle
                cx={5}
                cy={5}
                r={4}
                fill={muted[band.key] ? theme.colors.bandNeutral : theme.colors[band.token]}
                opacity={muted[band.key] ? 0.6 : 1}
              />
            </Svg>
            {/* Tone stays `secondary` even when muted: `muted` text is gated to
                large/incidental variants for contrast (see ui/text.tsx), and the
                gray dot + caption already carry the state. */}
            <Text variant="label" tone="secondary">
              {band.label}
            </Text>
            {muted[band.key] ? (
              <Text variant="caption" tone="muted">
                · none detected
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
