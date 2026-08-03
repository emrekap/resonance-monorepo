import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface SocialButtonProps {
  label: string;
  glyph: string;
  onPress?: () => void;
  disabled?: boolean;
  /** Renders a "Soon" badge for providers that exist in the roadmap only. */
  comingSoon?: boolean;
  busy?: boolean;
}

/** One row in the social-provider stack on the sign-in / sign-up screens. */
export function SocialButton({
  label,
  glyph,
  onPress,
  disabled,
  comingSoon,
  busy,
}: SocialButtonProps) {
  const theme = useTheme();
  const blocked = disabled || comingSoon || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={blocked ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: theme.border,
          opacity: comingSoon ? 0.5 : 1,
        },
      ]}
    >
      <View style={[styles.glyph, { backgroundColor: theme.background }]}>
        {busy ? (
          <ActivityIndicator size="small" color={theme.textSecondary} />
        ) : (
          <ThemedText type="smallBold">{glyph}</ThemedText>
        )}
      </View>
      <ThemedText type="default" style={styles.label}>
        {label}
      </ThemedText>
      {comingSoon ? (
        <ThemedText type="small" themeColor="textSecondary">
          Soon
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  glyph: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
  },
});
