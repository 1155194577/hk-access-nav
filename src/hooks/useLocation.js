/**
 * Location.
 *
 * Hong Kong's dense high-rises routinely produce 50-100 m of GPS error, and the
 * difference between a usable and unusable fix matters enormously here: giving
 * turn-by-turn directions from a 200 m error will walk someone into traffic. So
 * the fix is classified rather than simply passed on, and the UI is expected to
 * say "waiting for a good signal" instead of guessing.
 */

import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isFixUsable } from '@/providers/route';

export function useLocation(options = {}) {
  const { enabled = true, intervalMs = 3000, distanceInterval = 2 } = options;

  const [permission, setPermission] = useState(null);
  const [location, setLocation] = useState(null);
  const [error, setError] = useState(null);
  const subscription = useRef(null);

  const request = useCallback(async () => {
    try {
      const result = await Location.requestForegroundPermissionsAsync();
      setPermission(result.status);
      return result.status === 'granted';
    } catch (err) {
      setError(err?.message ?? 'location permission failed');
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const current = await Location.getForegroundPermissionsAsync();
        if (cancelled) return;
        setPermission(current.status);

        const granted = current.status === 'granted' ? true : await request();
        if (!granted || cancelled) return;

        // A last-known fix means the app has something to say immediately rather
        // than going silent for the first ten seconds.
        const last = await Location.getLastKnownPositionAsync();
        if (last && !cancelled) setLocation(toFix(last));

        subscription.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: intervalMs,
            distanceInterval,
          },
          (update) => {
            if (!cancelled) setLocation(toFix(update));
          }
        );
      } catch (err) {
        if (!cancelled) setError(err?.message ?? 'location unavailable');
      }
    }

    if (enabled) void start();

    return () => {
      cancelled = true;
      try {
        subscription.current?.remove?.();
      } catch {
        /* ignore */
      }
      subscription.current = null;
    };
  }, [enabled, intervalMs, distanceInterval, request]);

  return {
    permission,
    location,
    error,
    request,
    /** False while we are still waiting for a fix good enough to navigate from. */
    isUsable: isFixUsable(location),
    hasFix: location != null,
  };
}

function toFix(position) {
  const coords = position?.coords ?? {};
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy ?? null,
    heading: Number.isFinite(coords.heading) && coords.heading >= 0 ? coords.heading : null,
    speed: coords.speed ?? null,
    timestamp: position?.timestamp ?? Date.now(),
  };
}

/**
 * Compass heading.
 *
 * iOS reports heading as -1 when it is unavailable, which is easy to mistake for
 * "north". That would make every clock-direction instruction wrong, so an
 * unusable heading becomes null and the caller speaks a compass bearing instead.
 */
export function normaliseHeading(heading) {
  if (!Number.isFinite(heading) || heading < 0 || heading >= 360) return null;
  return heading;
}
