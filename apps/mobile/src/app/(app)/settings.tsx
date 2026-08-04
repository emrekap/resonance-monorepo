import { View } from 'react-native';

import { Button, Card, Screen, Text } from '@/components/ui';
import { useThemePreference, type ThemePreference } from '@/design';

const OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Follow the system appearance' },
  { value: 'light', label: 'Light', hint: 'Always use the light theme' },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark theme' },
];

export default function SettingsScreen() {
  const { preference, setPreference } = useThemePreference();

  return (
    <Screen scroll>
      <Text variant="title">Settings</Text>

      <Card>
        <Text variant="eyebrow" tone="secondary">
          Appearance
        </Text>
        <View style={{ gap: 8 }} accessibilityRole="radiogroup">
          {OPTIONS.map((option) => (
            <Button
              key={option.value}
              label={option.label}
              variant={preference === option.value ? 'primary' : 'secondary'}
              fullWidth
              accessibilityRole="radio"
              accessibilityState={{
                selected: preference === option.value,
                checked: preference === option.value,
              }}
              onPress={() => setPreference(option.value)}
            />
          ))}
        </View>
        <Text variant="caption" tone="secondary">
          {OPTIONS.find((option) => option.value === preference)?.hint}
        </Text>
      </Card>
    </Screen>
  );
}
