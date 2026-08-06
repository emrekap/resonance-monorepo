import { ConnectionStatus } from '@repo/db/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { ActivityIndicator, Alert, RefreshControl, StyleSheet, View } from 'react-native';

import { SocialButton } from '@/components/social-button';
import { Button, Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import {
  CONNECTABLE_PLATFORMS,
  PLATFORM_LABELS,
  type ConnectablePlatformConfig,
} from '@/lib/social';

const ACCOUNTS_KEY = ['connected-accounts'] as const;

function useConnectedAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: async () => {
      const res = await api['connected-accounts'].$get({ query: {} });
      if (res.status !== 200) throw new Error('Could not load connected accounts');
      return (await res.json()).accounts;
    },
  });
}

/**
 * Connect / manage platform accounts. The OAuth consent happens in a browser
 * tab against the API (which holds the platform secrets); the API's callback
 * bounces the browser back here via the `returnTo` deep link, so all this
 * screen does afterwards is refetch.
 */
export default function AccountsScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const accounts = useConnectedAccounts();

  // Set when the API callback redirect lands as a cold-start deep link
  // (resonance://accounts?connected=youtube) instead of resolving inside
  // openAuthSessionAsync below.
  const params = useLocalSearchParams<{ connected?: string; error?: string }>();
  useEffect(() => {
    if (params.connected) void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  }, [params.connected, queryClient]);

  const connect = useMutation({
    mutationFn: async (platform: ConnectablePlatformConfig) => {
      const returnTo = Linking.createURL('/accounts');
      const res = await api['connected-accounts'][':platform'].start.$post({
        param: { platform: platform.param },
        json: { returnTo },
      });
      if (res.status !== 200) {
        const body = await res.json();
        // 400s from the zod validator carry a ZodError object, not a string.
        const reason = 'error' in body && typeof body.error === 'string' ? body.error : null;
        throw new Error(reason ?? 'connect_failed');
      }
      const { url } = await res.json();

      const result = await WebBrowser.openAuthSessionAsync(url, returnTo);
      if (result.type !== 'success') return;
      const outcome = Linking.parse(result.url).queryParams ?? {};
      if (outcome.error) throw new Error(String(outcome.error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
    onError: (cause) => Alert.alert('Connection failed', cause.message),
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      const res = await api['connected-accounts'][':id'].$delete({ param: { id } });
      if (res.status !== 200) throw new Error('Could not disconnect this account');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
    onError: (cause) => Alert.alert('Disconnect failed', cause.message),
  });

  const confirmDisconnect = (id: string, label: string) => {
    Alert.alert(
      `Disconnect ${label}?`,
      'Resonance loses access to its analytics. Platform data is scheduled for deletion.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: () => disconnect.mutate(id) },
      ],
    );
  };

  const statusColor: Record<ConnectionStatus, string> = {
    [ConnectionStatus.ACTIVE]: theme.colors.success,
    [ConnectionStatus.EXPIRED]: theme.colors.warning,
    [ConnectionStatus.REVOKED]: theme.colors.danger,
    [ConnectionStatus.DISCONNECTED]: theme.colors.textSecondary,
  };

  return (
    <Screen
      scroll
      refreshControl={
        <RefreshControl
          refreshing={accounts.isRefetching}
          onRefresh={() => void accounts.refetch()}
          tintColor={theme.colors.textSecondary}
        />
      }
    >
      <View style={{ gap: theme.space.sm }}>
        <Text variant="labelStrong" tone="secondary">
          CONNECTED
        </Text>
        {accounts.isPending ? (
          <ActivityIndicator
            style={[styles.loader, { margin: theme.space.sm }]}
            color={theme.colors.textSecondary}
          />
        ) : accounts.isError ? (
          <Text variant="label" tone="danger">
            Could not load your accounts. Pull to retry or check the API is running.
          </Text>
        ) : accounts.data.length === 0 ? (
          <Text variant="label" tone="secondary">
            Nothing connected yet. Connect a channel below — you can add several accounts per
            platform.
          </Text>
        ) : (
          accounts.data.map((account) => (
            <View
              key={account.id}
              style={[
                styles.accountRow,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.lg,
                  padding: theme.space.base,
                  gap: theme.space.base,
                },
              ]}
            >
              <View style={[styles.accountText, { gap: theme.space.xxs }]}>
                <Text variant="body">{account.handle ?? PLATFORM_LABELS[account.platform]}</Text>
                <Text variant="label" tone="secondary">
                  {PLATFORM_LABELS[account.platform]} ·{' '}
                  <Text variant="label" style={{ color: statusColor[account.status] }}>
                    {account.status.toLowerCase()}
                  </Text>
                </Text>
              </View>
              <Button
                label="Disconnect"
                variant="danger"
                size="sm"
                busy={disconnect.isPending && disconnect.variables === account.id}
                disabled={disconnect.isPending}
                onPress={() =>
                  confirmDisconnect(account.id, account.handle ?? PLATFORM_LABELS[account.platform])
                }
              />
            </View>
          ))
        )}
      </View>

      <View style={{ gap: theme.space.sm }}>
        <Text variant="labelStrong" tone="secondary">
          ADD AN ACCOUNT
        </Text>
        {CONNECTABLE_PLATFORMS.map((platform) => (
          <SocialButton
            key={platform.param}
            label={`Connect ${platform.label}`}
            glyph={platform.glyph}
            comingSoon={!platform.available}
            busy={connect.isPending && connect.variables?.param === platform.param}
            disabled={connect.isPending}
            onPress={() => connect.mutate(platform)}
          />
        ))}
        <Text variant="label" tone="secondary">
          Connecting grants read-only access to analytics. You can disconnect at any time.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loader: {
    alignSelf: 'flex-start',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  accountText: {
    flex: 1,
  },
});
