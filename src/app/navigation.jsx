import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { speech } from '@/core/speech';
import { clearTrip, startTrip, useTrip } from '@/core/store';
import { originFor, randomNearbyPoint } from '@/core/simulate';
import { bearingDegrees, clockDirection, distanceMeters, formatDistance } from '@/core/geo';
import * as haptics from '@/core/haptics';
import { ProximityPulse } from '@/core/haptics';
import { useHazardScanner } from '@/hooks/useHazardScanner';
import { useLocation } from '@/hooks/useLocation';
import { useScreenAnnouncement } from '@/hooks/useScreenAnnouncement';
import { announceAdaptive, useScreenReader } from '@/hooks/useScreenReader';
import { walkingRoute } from '@/providers/route';
import { Colors, Radius, Spacing, Typography } from '@/ui/theme';

const ARRIVE_RADIUS_M = 12;

export default function NavigationScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const mode = params.mode ?? 'destination';

  // Walking with the screen on for minutes at a time would otherwise lock the
  // phone mid-route, which for this user is a safety problem, not an annoyance.
  useKeepAwake();

  const { trip, destination } = useTrip();
  const { location, isUsable } = useLocation({ intervalMs: 2000 });
  const screenReader = useScreenReader();
  const [permission, requestPermission] = useCameraPermissions();
  const [plan, setPlan] = useState(trip);
  const [stepIndex, setStepIndex] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [isRouting, setIsRouting] = useState(false);

  const cameraRef = useRef(null);
  const pulse = useRef(new ProximityPulse());
  const announcedSteps = useRef(new Set());
  /** Guards against building the home route twice under React strict double-render. */
  const builtHome = useRef(false);

  const target = useMemo(() => {
    if (destination) return destination;
    return null;
  }, [destination]);

  useScreenAnnouncement(
    '導航中。',
    '跟住上面黃色指示行。',
    ['慢慢行，跟住語音指示']
  );

  // ---------------------------------------------------------------- routing
  /**
   * "Go back home".
   *
   * Home is SIMULATED for this build: a random point a short walk from wherever
   * the user is. The real app stores the user's own home coordinate on-device
   * (see core/storage.js) and routes there; using that here would just mean
   * "no home set" on a fresh install, which is not a useful demo.
   */
  const buildHomeRoute = useCallback(async () => {
    setIsRouting(true);
    try {
      const origin = originFor(location, isUsable);
      const home = randomNearbyPoint(origin);

      const built = await walkingRoute(origin, home, { language: 'yue' });
      const withTrip = {
        ...built,
        origin,
        startedAt: Date.now(),
        spokenName: '屋企（模擬）',
        simulated: true,
      };

      startTrip(withTrip, home);
      setPlan(withTrip);
    } catch (error) {
      speech.announce(`搵唔到路：${error?.message ?? '未知錯誤'}`, { priority: 'interrupt' });
    } finally {
      setIsRouting(false);
    }
  }, [location, isUsable]);

  useEffect(() => {
    if (mode === 'home' && !plan && !builtHome.current) {
      builtHome.current = true;
      void buildHomeRoute();
    }
  }, [mode, plan, buildHomeRoute]);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  // Announce the whole plan once, so the user knows what they are committing to.
  useEffect(() => {
    if (!plan) return;
    const first = plan.steps?.[0];
    const total = formatDistance(plan.totalDistanceMeters);
    speech.announce(
      `路線準備好，全程大約${total}。${first?.instruction ?? ''}`,
      { priority: 'interrupt' }
    );
  }, [plan]);

  // ------------------------------------------------------- progress & guidance
  const currentStep = plan?.steps?.[stepIndex] ?? null;

  /** Distance and bearing to the next waypoint / destination. */
  const guidance = useMemo(() => {
    if (!location) return null;

    const stepTarget =
      currentStep?.end ??
      (plan?.steps?.length ? plan.steps[plan.steps.length - 1].end : null) ??
      target;

    if (!stepTarget) return null;

    const distance = distanceMeters(location, stepTarget);
    const bearing = bearingDegrees(location, stepTarget);
    const heading = location.heading ?? null;

    return {
      distance,
      bearing,
      clock: clockDirection(bearing, heading),
      /** 0 far .. 1 at target; drives the proximity pulses. */
      closeness: Math.max(0, Math.min(1, 1 - distance / 200)),
    };
  }, [location, currentStep, plan, target]);

  // Advance the step as waypoints are reached, and speak each new instruction.
  useEffect(() => {
    if (!guidance || !plan?.steps?.length) return;

    if (guidance.distance <= ARRIVE_RADIUS_M) {
      const isLast = stepIndex >= plan.steps.length - 1;
      if (isLast) {
        if (!arrived) {
          setArrived(true);
          haptics.arrived();
          announceAdaptive(speech, '你已到達目的地。', {
            screenReader,
            priority: 'interrupt',
          });
        }
        return;
      }
      const next = stepIndex + 1;
      setStepIndex(next);
      const instruction = plan.steps[next]?.instruction;
      if (instruction && !announcedSteps.current.has(next)) {
        announcedSteps.current.add(next);
        haptics.double();
        // Turn-by-turn guidance must reach VoiceOver users too, so it goes
        // through whichever narrator is running.
        announceAdaptive(speech, instruction, {
          screenReader,
          priority: 'interrupt',
        });
      }
    }
  }, [guidance, plan, stepIndex, arrived, screenReader]);

  // Proximity pulses: a rising repetition rate conveys distance far better than
  // a spoken number that goes stale the moment it is said.
  useEffect(() => {
    if (!guidance || arrived) return;
    pulse.current.start(guidance.closeness);
    return () => pulse.current.stop();
  }, [guidance, arrived]);

  /** Re-read the current instruction on demand. */
  const repeatInstruction = useCallback(() => {
    haptics.tick();
    const text = arrived
      ? '你已到達目的地。'
      : currentStep?.instruction ?? '未有指示。';
    speech.announce(text, { priority: 'interrupt' });
  }, [arrived, currentStep]);

  const { hazard } = useHazardScanner({
    cameraRef,
    // Hazard scanning needs a camera; without one, navigation still works.
    enabled: Boolean(permission?.granted) && !arrived,
    language: 'yue',
  });

  function finish() {
    haptics.tick();
    pulse.current.stop();
    speech.announce('導航結束。', { priority: 'interrupt' });
    clearTrip();
    router.replace('/');
  }

  if (isRouting && !plan) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.loadingText}>Planning a safe route…</Text>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.root}>
      {permission?.granted ? (
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.noCamera]} />
      )}

      {/* AR guidance overlay: the tactile path and the obstacle box */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <TactilePathOverlay active={!arrived} />
        {hazard?.urgent ? <HazardBox /> : null}
      </View>

      <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
      {/* The banner is a live region for Android; on iOS a changing Text is not
          announced by itself, so step changes are spoken via announceAdaptive. */}
      <View style={styles.guidanceBanner} accessibilityLiveRegion="polite">
        <Text style={styles.guidanceLabel} accessibilityElementsHidden importantForAccessibility="no">
          GUIDANCE
        </Text>
        <Text
          style={styles.guidanceText}
          numberOfLines={2}
          accessibilityLabel={
            arrived ? 'You have arrived' : currentStep?.instruction ?? 'Waiting for a location fix'
          }>
          {arrived ? 'You have arrived' : currentStep?.instruction ?? 'Waiting for a fix…'}
        </Text>
        <View style={styles.guidanceMeta}>
          <Text style={styles.guidanceMetaText} accessibilityLabel={`Direction ${guidance?.clock ?? 'unknown'}`}>
            {guidance?.clock ?? '—'}
          </Text>
          <Text style={styles.guidanceMetaText} accessibilityLabel={`Distance ${guidance ? formatDistance(guidance.distance) : 'unknown'}`}>
            {guidance ? formatDistance(guidance.distance) : '—'}
          </Text>
        </View>
      </View>

        <View style={styles.spacer} />

        {/* Hazard warning */}
        {hazard?.urgent ? (
          <View style={styles.warningBanner} accessibilityLiveRegion="assertive">
            <Text style={styles.warningTitle}>WARNING!</Text>
            <Text style={styles.warningText}>
              {hazard.distanceMeters != null
                ? `Obstacle ${Math.round(hazard.distanceMeters)} m ahead at ${
                    guidance?.clock ?? '12 o\'clock'
                  }: `
                : 'Obstacle ahead: '}
              {hazard.description}
            </Text>
            {hazard.confidence === 'high' ? (
              <Text style={styles.warningAction}>Step slightly left.</Text>
            ) : (
              <Text style={styles.warningUncertain}>Not certain — proceed slowly.</Text>
            )}
          </View>
        ) : null}

        <View style={styles.controls}>
          <Pressable
            onPress={repeatInstruction}
            accessibilityRole="button"
            accessibilityLabel="Repeat the instruction"
            accessibilityHint="Says the current direction again."
            style={({ pressed }) => [styles.repeatButton, pressed && styles.pressed]}>
            <Text style={styles.repeatText}>REPEAT</Text>
          </Pressable>

          <Pressable
            onPress={finish}
            accessibilityRole="button"
            accessibilityLabel="End navigation"
            accessibilityHint="Stops guidance and returns to the main menu."
            style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}>
            <Text style={styles.stopText}>STOP</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

/**
 * The visual path hint: a dashed blue strip that reads as "tactile paving".
 *
 * Purely decorative for the target user, but it is what makes the screen legible
 * to a sighted companion or a partially sighted user, and the brief calls for it.
 */
function TactilePathOverlay({ active }) {
  if (!active) return null;

  return (
    <View style={styles.pathContainer}>
      {Array.from({ length: 7 }).map((_, index) => (
        <View
          key={index}
          style={[
            styles.pathSegment,
            {
              bottom: 120 + index * 46,
              opacity: 0.85 - index * 0.09,
              width: 120 - index * 10,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** Red translucent box marking a detected obstacle. */
function HazardBox() {
  return (
    <View style={styles.hazardBox}>
      <Text style={styles.hazardBoxLabel}>OBSTACLE</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
  },
  loadingText: {
    color: Colors.text,
    fontSize: Typography.body,
  },
  noCamera: {
    backgroundColor: Colors.surface,
  },
  overlay: {
    flex: 1,
    padding: Spacing.three,
    justifyContent: 'space-between',
  },
  guidanceBanner: {
    backgroundColor: Colors.warning,
    borderRadius: Radius.medium,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  guidanceLabel: {
    color: 'rgba(0,0,0,0.65)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  guidanceText: {
    color: '#101010',
    fontSize: Typography.body,
    fontWeight: '800',
  },
  guidanceMeta: {
    flexDirection: 'row',
    gap: Spacing.four,
    marginTop: Spacing.one,
  },
  guidanceMetaText: {
    color: '#101010',
    fontSize: Typography.caption,
    fontWeight: '700',
  },
  spacer: {
    flex: 1,
  },
  warningBanner: {
    backgroundColor: Colors.dangerSurface,
    borderColor: Colors.danger,
    borderWidth: 2,
    borderRadius: Radius.medium,
    padding: Spacing.three,
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  warningTitle: {
    color: Colors.danger,
    fontSize: Typography.title,
    fontWeight: '900',
    letterSpacing: 1,
  },
  warningText: {
    color: Colors.text,
    fontSize: Typography.body,
    fontWeight: '600',
  },
  warningAction: {
    color: Colors.warning,
    fontSize: Typography.body,
    fontWeight: '800',
  },
  warningUncertain: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    fontStyle: 'italic',
  },
  controls: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  repeatButton: {
    flex: 2,
    minHeight: 72,
    borderRadius: Radius.large,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repeatText: {
    color: '#FFFFFF',
    fontSize: Typography.button,
    fontWeight: '800',
    letterSpacing: 1,
  },
  stopButton: {
    flex: 1,
    minHeight: 72,
    borderRadius: Radius.large,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopText: {
    color: Colors.text,
    fontSize: Typography.button,
    fontWeight: '800',
    letterSpacing: 1,
  },
  pressed: {
    opacity: 0.75,
  },
  pathContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
  },
  pathSegment: {
    position: 'absolute',
    height: 26,
    borderRadius: 6,
    backgroundColor: Colors.path,
  },
  hazardBox: {
    position: 'absolute',
    left: '25%',
    right: '25%',
    top: '45%',
    height: 120,
    borderWidth: 3,
    borderColor: Colors.danger,
    backgroundColor: Colors.dangerSurface,
    borderRadius: Radius.small,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: Spacing.one,
  },
  hazardBoxLabel: {
    color: Colors.danger,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
