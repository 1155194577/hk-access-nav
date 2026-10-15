import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import * as haptics from '@/core/haptics';
import { describeNearest, formatDistance, nearestStations, stationName } from '@/core/nearest-stations';
import { speech } from '@/core/speech';
import { startTrip } from '@/core/store';
import { useLocation } from '@/hooks/useLocation';
import { useScreenAnnouncement } from '@/hooks/useScreenAnnouncement';
import { announceAdaptive, useScreenReader } from '@/hooks/useScreenReader';
import { hasOfflineCoverage, offlineAreas, walkingRoute } from '@/providers/route';
import { Colors, Radius, Spacing, Typography } from '@/ui/theme';

const ACTIONS = [
  'Swipe through the nearest MTR stations',
  'Double tap a station to navigate there',
];

/** How far out to look. Beyond this a station is not a realistic walk. */
const SEARCH_RADIUS_M = 3000;

export default function VisitScreen() {
  const router = useRouter();
  const screenReader = useScreenReader();
  const { location, isUsable, hasFix, error: locationError, request } = useLocation({
    intervalMs: 3000,
  });

  const [stations, setStations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState('idle');

  useScreenAnnouncement(
    '最近地鐵站。',
    '用你嘅位置，列出最近嘅地鐵站。',
    ACTIONS
  );

  // Recompute as the fix updates. Cheap: 66 stations.
  useEffect(() => {
    if (!isUsable) {
      setStations([]);
      return;
    }
    setStations(nearestStations(location, { limit: 6, maxMeters: SEARCH_RADIUS_M }));
  }, [location, isUsable]);

  // Announce the list once it settles, so the user is not read a list that then
  // changes under them as the GPS jitters.
  const announcement = useMemo(() => (stations.length > 0 ? describeNearest(stations, 'yue') : ''), [stations]);
  useEffect(() => {
    if (!announcement) return undefined;
    const timer = setTimeout(() => {
      announceAdaptive(speech, announcement, { screenReader, priority: 'normal' });
    }, 600);
    return () => clearTimeout(timer);
  }, [announcement, screenReader]);

  const goTo = useCallback(
    async (station) => {
      if (status === 'routing') return;
      setSelected(station.id);
      setStatus('routing');
      haptics.tick();

      const destination = {
        latitude: station.latitude,
        longitude: station.longitude,
        accuracy: null,
      };

      if (!hasOfflineCoverage(location) || !hasOfflineCoverage(destination)) {
        setStatus('idle');
        haptics.error();
        const areas = offlineAreas().join(', ');
        announceAdaptive(
          speech,
          `呢個位置冇離線地圖。已載入嘅區域：${areas}。`,
          { screenReader, priority: 'interrupt' }
        );
        return;
      }

      try {
        const plan = await walkingRoute(location, destination, { language: 'yue' });
        startTrip(
          {
            ...plan,
            origin: location,
            startedAt: Date.now(),
            spokenName: stationName(station, 'yue'),
          },
          destination
        );
        haptics.success();
        router.push({ pathname: '/navigation', params: { mode: 'destination' } });
      } catch (error) {
        setStatus('idle');
        setSelected(null);
        haptics.error();
        announceAdaptive(speech, `搵唔到路：${error?.message ?? '未知錯誤'}`, {
          screenReader,
          priority: 'interrupt',
        });
      }
    },
    [location, router, screenReader, status]
  );

  const reroute = useCallback(() => {
    haptics.tick();
    announceAdaptive(speech, announcement || '仲未收到定位信號。', {
      screenReader,
      priority: 'interrupt',
    });
  }, [announcement, screenReader]);

  // ------------------------------------------------------------------ states

  if (!hasFix) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <View style={styles.centered}>
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.centeredTitle}>Finding your location…</Text>
          <Text style={styles.centeredBody}>
            The nearest stations are listed once there is a position fix.
          </Text>
          <Pressable
            onPress={request}
            accessibilityRole="button"
            accessibilityLabel="Retry location"
            accessibilityHint="Asks for location permission again."
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
            <Text style={styles.retryText}>RETRY</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.headerLabel}>YOUR LOCATION</Text>
          <Text style={styles.headerValue}>
            {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
          </Text>
          <Text style={styles.headerMeta}>
            accurate to about {Math.round(location.accuracy ?? 0)} m
            {isUsable ? '' : ' — too imprecise to navigate from'}
          </Text>
        </View>

        {!isUsable ? (
          <View style={styles.warning}>
            <Text style={styles.warningText}>
              The location fix is not good enough to navigate from (
              {Math.round(location.accuracy ?? 0)} m). Move somewhere more open and try
              again — Hong Kong's tall buildings routinely block GPS.
            </Text>
          </View>
        ) : null}

        <Text style={styles.sectionLabel}>
          NEAREST MTR STATIONS {stations.length > 0 ? `(${stations.length})` : ''}
        </Text>

        {stations.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No MTR station within {SEARCH_RADIUS_M / 1000} km
              {locationError ? ` — ${locationError}` : ''}.
            </Text>
          </View>
        ) : (
          stations.map((station) => {
            const busy = selected === station.id && status === 'routing';
            const covered = hasOfflineCoverage({
              latitude: station.latitude,
              longitude: station.longitude,
            });
            return (
              <Pressable
                key={station.id}
                onPress={() => goTo(station)}
                disabled={status === 'routing'}
                accessibilityRole="button"
                accessibilityLabel={`${stationName(station, 'en')}, ${stationName(
                  station,
                  'tc'
                )}, about ${formatDistance(station.straightLineMeters, 'en')} away${
                  station.clock ? `, ${station.clock}` : ''
                }`}
                accessibilityHint={
                  covered
                    ? 'Double tap to navigate to this station.'
                    : 'No offline map covers this station yet.'
                }
                accessibilityState={{ disabled: status === 'routing', busy }}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <View style={styles.cardBody}>
                  <Text style={styles.stationName}>
                    {stationName(station, 'en')} · {stationName(station, 'tc')}
                  </Text>
                  <Text style={styles.stationMeta}>
                    {formatDistance(station.straightLineMeters, 'en')} straight line
                    {station.clock ? ` · ${station.clock}` : ''}
                    {covered ? '' : ' · no offline map'}
                  </Text>
                </View>
                {busy ? (
                  <ActivityIndicator color={Colors.primary} />
                ) : (
                  <Text style={styles.chevron}>›</Text>
                )}
              </Pressable>
            );
          })
        )}

        <Pressable
          onPress={reroute}
          accessibilityRole="button"
          accessibilityLabel="Repeat the nearest stations"
          accessibilityHint="Reads the list again."
          style={({ pressed }) => [styles.repeat, pressed && styles.pressed]}>
          <Text style={styles.repeatText}>REPEAT LIST</Text>
        </Pressable>

        <Text style={styles.footnote}>
          Distances are measured in a straight line, not along walkable paths. Open a
          station to get the real walking route.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.three, gap: Spacing.two, paddingBottom: Spacing.six },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
  centeredTitle: { color: Colors.text, fontSize: Typography.body, fontWeight: '700' },
  centeredBody: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    textAlign: 'center',
  },
  retry: {
    marginTop: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.five,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  retryText: { color: '#FFFFFF', fontSize: Typography.caption, fontWeight: '800' },
  header: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.medium,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  headerLabel: { color: Colors.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  headerValue: { color: Colors.text, fontSize: Typography.body, fontWeight: '700' },
  headerMeta: { color: Colors.textSecondary, fontSize: Typography.caption },
  warning: {
    backgroundColor: Colors.warningSurface,
    borderColor: Colors.warning,
    borderWidth: 1,
    borderRadius: Radius.medium,
    padding: Spacing.three,
  },
  warningText: { color: Colors.warning, fontSize: Typography.caption, lineHeight: 19 },
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: Spacing.two,
  },
  empty: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.medium,
    padding: Spacing.four,
  },
  emptyText: { color: Colors.textSecondary, fontSize: Typography.caption, textAlign: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 72,
    backgroundColor: Colors.surface,
    borderRadius: Radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  cardBody: { flex: 1, gap: Spacing.one },
  stationName: { color: Colors.text, fontSize: Typography.body, fontWeight: '700' },
  stationMeta: { color: Colors.textSecondary, fontSize: Typography.caption },
  chevron: { color: Colors.textSecondary, fontSize: 26, fontWeight: '700' },
  repeat: {
    marginTop: Spacing.three,
    minHeight: 64,
    borderRadius: Radius.large,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repeatText: { color: '#FFFFFF', fontSize: Typography.button, fontWeight: '800', letterSpacing: 1 },
  footnote: {
    color: Colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: Spacing.two,
  },
  pressed: { opacity: 0.75 },
});
