import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export interface ChipProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A selectable pill — the filter control.
 *
 * Separate from `Badge`, which shares the geometry but is display-only: no
 * press handler, no selected state, and therefore nothing to announce to a
 * screen reader. Selection is carried by `accentSubtle` + its dedicated
 * `onAccentSubtle` text token rather than by weight alone, so the active filter
 * survives a glance in either scheme.
 */
export function Chip({ label, selected = false, disabled, style, ...rest }: ChipProps) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={theme.space.xs}
      style={({ pressed }) => [
        {
          justifyContent: 'center',
          // 36 is below the 40 floor `Button` keeps, and deliberately so: a
          // filter row of 40pt pills eats the list. The hitSlop above puts the
          // touch target back over the guidance.
          minHeight: 36,
          paddingHorizontal: theme.space.base,
          borderRadius: theme.radius.pill,
          borderWidth: 1,
          borderColor: selected ? 'transparent' : theme.colors.border,
          backgroundColor: selected
            ? theme.colors.accentSubtle
            : pressed
              ? theme.colors.surfaceElevated
              : theme.colors.surface,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
      {...rest}
    >
      <Text
        variant="labelStrong"
        tone={selected ? 'onAccentSubtle' : 'secondary'}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
