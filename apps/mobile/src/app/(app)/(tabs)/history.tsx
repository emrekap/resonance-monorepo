import { AnalysisStatus, MediaKind } from '@repo/db/browser';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AnalysisRow } from '@/components/analysis-row';
import { Button, Card, Chip, Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { useAnalyses, type AnalysisSort } from '@/hooks/use-analyses';

/**
 * Four chips over five statuses: "Running" is the two transient ones, and
 * CANCELLED is reachable only through "All" — nothing produces it yet, so it
 * does not deserve a chip of its own.
 */
const STATUS_FILTERS = {
  all: { label: 'All', value: undefined },
  done: { label: 'Done', value: [AnalysisStatus.SUCCEEDED] },
  running: { label: 'Running', value: [AnalysisStatus.QUEUED, AnalysisStatus.PROCESSING] },
  failed: { label: 'Failed', value: [AnalysisStatus.FAILED] },
} as const satisfies Record<string, { label: string; value: AnalysisStatus[] | undefined }>;

type StatusFilter = keyof typeof STATUS_FILTERS;

const KIND_FILTERS = [
  { label: 'Video', value: MediaKind.VIDEO },
  { label: 'Audio', value: MediaKind.AUDIO },
  { label: 'Image', value: MediaKind.IMAGE },
] as const;

const SORT_KEYS = ['createdAt', 'completedAt', 'resonanceScore'] as const;
const SORT_LABEL: Record<AnalysisSort, string> = {
  createdAt: 'Started',
  completedAt: 'Finished',
  resonanceScore: 'Score',
};

/**
 * The History tab — every analysis in the workspace, paged, filtered, sorted.
 *
 * Filter state is local and deliberately not persisted: nothing deep-links into
 * a filtered history, and a tab that reopens on "All" is what a user expects.
 */
export default function HistoryScreen() {
  const theme = useTheme();
  const router = useRouter();

  const [status, setStatus] = useState<StatusFilter>('all');
  const [kinds, setKinds] = useState<MediaKind[]>([]);
  const [sort, setSort] = useState<AnalysisSort>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  const filters = useMemo(
    () => ({
      status: STATUS_FILTERS[status].value,
      kind: kinds.length ? kinds : undefined,
      sort,
      order,
    }),
    [status, kinds, sort, order],
  );
  const analyses = useAnalyses(filters);
  const { refetch } = analyses;

  // Pull-to-refresh tracks the *gesture*, not the query. `isRefetching` is true
  // for any background refetch — every realtime invalidation included — so
  // binding the control to it flashes the spinner and shifts the list down each
  // time a job changes status.
  const [pulling, setPulling] = useState(false);
  const pullToRefresh = useCallback(() => {
    setPulling(true);
    void refetch().finally(() => setPulling(false));
  }, [refetch]);

  const rows = useMemo(
    () => analyses.data?.pages.flatMap((page) => page.items) ?? [],
    [analyses.data],
  );
  const total = analyses.data?.pages[0]?.page.total ?? 0;
  const filtered = status !== 'all' || kinds.length > 0;

  const toggleKind = (kind: MediaKind) =>
    setKinds((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    );

  const clearFilters = () => {
    setStatus('all');
    setKinds([]);
  };

  /** Same key again flips direction; a new key starts at descending. */
  const chooseSort = (key: AnalysisSort) => {
    if (key === sort) setOrder((current) => (current === 'desc' ? 'asc' : 'desc'));
    else {
      setSort(key);
      setOrder('desc');
    }
  };

  const openSortMenu = () => {
    const labels = SORT_KEYS.map((key) => SORT_LABEL[key]);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Sort by', options: [...labels, 'Cancel'], cancelButtonIndex: labels.length },
        (index) => {
          if (index < labels.length) chooseSort(SORT_KEYS[index]!);
        },
      );
      return;
    }
    // Android's AlertDialog carries at most three buttons, so the three sort
    // keys use all of them — dismissing is the cancel.
    Alert.alert(
      'Sort by',
      undefined,
      SORT_KEYS.map((key) => ({ text: SORT_LABEL[key], onPress: () => chooseSort(key) })),
    );
  };

  return (
    <Screen padded={false}>
      {/* Pinned, not a list header: a filtered list that hides its own filters
          is how someone concludes their analyses are gone. */}
      <View style={{ gap: theme.space.sm, paddingHorizontal: theme.space.lg }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.space.sm }}
        >
          {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((key) => (
            <Chip
              key={key}
              label={STATUS_FILTERS[key].label}
              selected={status === key}
              onPress={() => setStatus(key)}
            />
          ))}
        </ScrollView>

        <View style={[styles.sortRow, { gap: theme.space.sm }]}>
          <View style={[styles.kinds, { gap: theme.space.sm }]}>
            {KIND_FILTERS.map((kind) => (
              <Chip
                key={kind.value}
                label={kind.label}
                selected={kinds.includes(kind.value)}
                onPress={() => toggleKind(kind.value)}
              />
            ))}
          </View>
          <Button
            label={SORT_LABEL[sort]}
            variant="ghost"
            size="sm"
            icon={order === 'desc' ? 'arrow-down' : 'arrow-up'}
            onPress={openSortMenu}
          />
        </View>
      </View>

      {analyses.isPending ? (
        <ActivityIndicator color={theme.colors.textSecondary} />
      ) : analyses.isError ? (
        <View style={{ paddingHorizontal: theme.space.lg }}>
          <Card>
            <Text variant="label" tone="danger">
              {analyses.error.message}
            </Text>
            <Button
              label="Try again"
              variant="secondary"
              size="sm"
              onPress={() => void analyses.refetch()}
            />
          </Card>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <AnalysisRow analysis={item} onPress={() => router.push(`/analysis/${item.id}`)} />
          )}
          // `flex: 1` is not decoration: inside `Screen`'s flex column a list
          // without it sizes to its content and clips instead of scrolling.
          style={styles.list}
          contentContainerStyle={{
            paddingHorizontal: theme.space.lg,
            paddingBottom: theme.space.xl,
            gap: theme.space.sm,
          }}
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              onRefresh={pullToRefresh}
              tintColor={theme.colors.textSecondary}
            />
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (analyses.hasNextPage && !analyses.isFetchingNextPage) void analyses.fetchNextPage();
          }}
          ListHeaderComponent={
            rows.length > 0 ? (
              <Text variant="caption" tone="secondary">
                {total} {total === 1 ? 'analysis' : 'analyses'}
                {filtered ? ' matching' : ''}
              </Text>
            ) : null
          }
          ListFooterComponent={
            analyses.isFetchingNextPage ? (
              <ActivityIndicator
                style={{ marginTop: theme.space.base }}
                color={theme.colors.textSecondary}
              />
            ) : null
          }
          ListEmptyComponent={
            <Card>
              <Text variant="labelStrong">
                {filtered ? 'Nothing matches these filters' : 'No analyses yet'}
              </Text>
              <Text variant="label" tone="secondary">
                {filtered
                  ? 'Try a wider status or media type.'
                  : 'Run one from Home and it will show up here.'}
              </Text>
              {filtered ? (
                <Button
                  label="Clear filters"
                  variant="secondary"
                  size="sm"
                  onPress={clearFilters}
                />
              ) : (
                <Button
                  label="Start an analysis"
                  variant="secondary"
                  size="sm"
                  // Home is a sibling tab, so this is a switch — `push` would
                  // stack a second copy of the whole tab bar.
                  onPress={() => router.navigate('/')}
                />
              )}
            </Card>
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  kinds: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
