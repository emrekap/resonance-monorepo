import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';

import { useTheme } from '@/hooks/use-theme';

/**
 * The signed-in shell. The root layout's `Stack.Protected` guard is the only
 * gate — by the time this mounts there is a session, so screens below just use
 * `useSession()` / the RPC client.
 */
export default function AppLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textSecondary,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Ionicons name="pulse" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="accounts"
        options={{
          title: 'Accounts',
          tabBarIcon: ({ color, size }) => <Ionicons name="link" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
