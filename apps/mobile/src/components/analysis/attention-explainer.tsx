import { Modal, Pressable, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Button, Text } from '@/components/ui';
import { useTheme } from '@/design';

import { BANDS, type BandKey } from './timeline-math';

/**
 * What the three timeline lines are — and are not.
 *
 * The one misreading this screen invites is "the audio line grades my audio".
 * It does not: every line is the model's predicted response in a network of a
 * *viewer's* brain, and the model predicts all of them no matter what the clip
 * contains. This sheet says that once, plainly, so the chart never has to.
 */

const BAND_COPY: Record<BandKey, { title: string; body: string }> = {
  visual: {
    title: 'Visual',
    body: 'Predicted response in the visual areas of the brain — driven by imagery, motion and cuts.',
  },
  audio: {
    title: 'Audio',
    body: 'Predicted response in the auditory areas — driven by sound, music and voice.',
  },
  language: {
    title: 'Language',
    body: 'Predicted response in the language network — driven by speech being followed and understood.',
  },
};

export interface AttentionExplainerProps {
  visible: boolean;
  onClose: () => void;
}

export function AttentionExplainer({ visible, onClose }: AttentionExplainerProps) {
  const theme = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The backdrop dismisses; the sheet swallows its own presses. */}
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.6)', justifyContent: 'flex-end' }}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      >
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={{
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius.xl,
            borderTopRightRadius: theme.radius.xl,
            borderColor: theme.colors.border,
            borderWidth: 1,
            padding: theme.space.lg,
            paddingBottom: theme.space.xl,
            gap: theme.space.md,
          }}
        >
          <Text variant="heading">Reading this chart</Text>

          <Text variant="label" tone="secondary">
            Each line predicts how strongly a network in a viewer&apos;s brain responds to your
            clip, second by second — where attention comes from, not a grade of your footage or
            sound quality.
          </Text>

          {BANDS.map((band) => (
            <View
              key={band.key}
              style={{ flexDirection: 'row', gap: theme.space.sm, alignItems: 'flex-start' }}
            >
              <Svg width={10} height={10} style={{ marginTop: 5 }}>
                <Circle cx={5} cy={5} r={4} fill={theme.colors[band.token]} />
              </Svg>
              <View style={{ flex: 1, gap: theme.space.xxs }}>
                <Text variant="labelStrong">{BAND_COPY[band.key].title}</Text>
                <Text variant="label" tone="secondary">
                  {BAND_COPY[band.key].body}
                </Text>
              </View>
            </View>
          ))}

          <View style={{ flexDirection: 'row', gap: theme.space.sm, alignItems: 'flex-start' }}>
            <Svg width={10} height={10} style={{ marginTop: 5 }}>
              <Circle cx={5} cy={5} r={4} fill={theme.colors.bandNeutral} opacity={0.6} />
            </Svg>
            <View style={{ flex: 1, gap: theme.space.xxs }}>
              <Text variant="labelStrong">A faded line</Text>
              <Text variant="label" tone="secondary">
                Means the clip doesn&apos;t contain that channel — no soundtrack, no speech, or no
                imagery. The model still predicts a baseline response, but there&apos;s nothing in
                your content behind it, so don&apos;t read into it.
              </Text>
            </View>
          </View>

          <Button label="Got it" variant="secondary" fullWidth onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
