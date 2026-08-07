import { useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Text } from '@/components/ui';
import { useTheme } from '@/design';

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
 */

/**
 * Deliberately no `attention` field, though the API returns one.
 *
 * That array is the brain-wide mean, and independent work (arXiv 2607.01400,
 * cited in docs/resonance-model-design.md §0) shows it does *not* predict
 * engagement — the signal is in specific networks. It stays in the database as
 * telemetry; drawing it would put the one debunked curve on the hero chart.
 */
export type TimelineBands = {
  startSec: readonly number[];
  visual: readonly number[];
  audio: readonly number[];
  language: readonly number[];
};

export type TimelineMarker = {
  kind: 'peak' | 'dip';
  startSec: number;
};

export interface AttentionTimelineProps {
  timeline: TimelineBands;
  /** Highlighted moment, set when a recommendation row is tapped. */
  focusSec?: number | null;
  height?: number;
}

/**
 * The strongest peak and deepest dip in the combined response.
 *
 * Derived here rather than passed in. The screen only knows which moments the
 * recommendations point at, and it cannot tell a peak from a dip — an earlier
 * version mapped every recommendation to `kind: 'dip'`, so a moment the model
 * praised was drawn in warning colour. The curve is right here; classifying it
 * is three lines and cannot disagree with what is on screen.
 *
 * `apps/worker` runs its own marker detection for the prompt. The two need not
 * agree: that one decides what Claude explains, this one decides what a creator
 * sees, and both read the same curve.
 */
function deriveMarkers(timeline: TimelineBands): TimelineMarker[] {
  const combined = timeline.startSec.map((startSec, index) => ({
    startSec,
    value:
      (timeline.visual[index] ?? 0) +
      (timeline.audio[index] ?? 0) +
      (timeline.language[index] ?? 0),
  }));
  if (combined.length < 3) return [];

  const sorted = [...combined].sort((a, b) => a.value - b.value);
  const dip = sorted[0];
  const peak = sorted[sorted.length - 1];
  if (!dip || !peak || dip.startSec === peak.startSec) return [];

  return [
    { kind: 'peak' as const, startSec: peak.startSec },
    { kind: 'dip' as const, startSec: dip.startSec },
  ].sort((a, b) => a.startSec - b.startSec);
}

const BANDS = [
  { key: 'visual', label: 'Visual', token: 'bandVisual' },
  { key: 'audio', label: 'Audio', token: 'bandAudio' },
  { key: 'language', label: 'Language', token: 'bandLanguage' },
] as const;

/** `73.5` -> `1:13`. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Build an SVG path for one band.
 *
 * All three bands share one y-scale, taken across all of them together, so their
 * relative heights are comparable. Scaling each band to its own range would make
 * a flat audio track look as dynamic as a busy visual one.
 */
function buildPath(
  values: readonly number[],
  xs: readonly number[],
  domain: { min: number; max: number },
  width: number,
  height: number,
): string {
  if (values.length === 0 || xs.length === 0) return '';
  const spanX = Math.max(1e-6, (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0));
  const spanY = Math.max(1e-6, domain.max - domain.min);

  return values
    .map((value, index) => {
      const x = (((xs[index] ?? 0) - (xs[0] ?? 0)) / spanX) * width;
      // SVG y grows downward; invert so a higher response draws higher.
      const y = height - ((value - domain.min) / spanY) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

export function AttentionTimeline({
  timeline,
  focusSec = null,
  height = 132,
}: AttentionTimelineProps) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const markers = useMemo(() => deriveMarkers(timeline), [timeline]);

  const domain = useMemo(() => {
    const all = [...timeline.visual, ...timeline.audio, ...timeline.language];
    if (all.length === 0) return { min: 0, max: 1 };
    const min = Math.min(...all);
    const max = Math.max(...all);
    // A perfectly flat clip would give a zero span and divide by ~0; pad it so
    // the line renders down the middle instead of at an edge.
    return max - min < 1e-6 ? { min: min - 0.5, max: max + 0.5 } : { min, max };
  }, [timeline]);

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

            {BANDS.map((band) => (
              <Path
                key={band.key}
                d={buildPath(timeline[band.key], xs, domain, width, height)}
                stroke={theme.colors[band.token]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                fill="none"
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
              <Circle cx={5} cy={5} r={4} fill={theme.colors[band.token]} />
            </Svg>
            <Text variant="label" tone="secondary">
              {band.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
