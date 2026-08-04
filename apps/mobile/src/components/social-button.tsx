import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { useTheme } from '@/design';

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
      style={({ pressed }) =>
        StyleSheet.flatten([
          styles.button,
          {
            backgroundColor: pressed ? theme.colors.surfaceElevated : theme.colors.surface,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.lg,
            gap: theme.space.base,
            paddingVertical: theme.space.base,
            paddingHorizontal: theme.space.base,
            opacity: comingSoon ? 0.5 : 1,
          },
        ])
      }
    >
      <View
        style={[
          styles.glyph,
          { backgroundColor: theme.colors.canvas, borderRadius: theme.radius.pill },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        ) : (
          <Text variant="labelStrong">{glyph}</Text>
        )}
      </View>
      <Text variant="body" style={styles.label}>
        {label}
      </Text>
      {comingSoon ? (
        <Text variant="label" tone="secondary">
          Soon
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  glyph: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
  },
});
