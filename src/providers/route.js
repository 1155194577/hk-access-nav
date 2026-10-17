/**
 * Route planning, preferring the on-device network.
 *
 * Order of preference, and the reasoning:
 *
 *   1. ON-DEVICE — the bundled CSDI subgraphs. No network, no key, no server.
 *      This is the default because the app's job is to guide someone who may be
 *      standing in the rain with no signal. It also carries the accessibility
 *      attributes that make step-free routing real: staircases, lifts, ramps,
 *      gradients, and indoor concourses.
 *
 *   2. THE SERVER — the team's HK Nav endpoint. Kept only as a fallback for
 *      coordinates outside the districts bundled into the app. Its routing
 *      response is a stub (verified: two fixed strings, "45.0 metres"), so a
 *      route from it is labelled as unverified and the app says so.
 *
 *   3. STRAIGHT LINE — last resort, and it ANNOUNCES ITSELF. A deliberate
 *      direct line that does not follow footpaths must never be presented as a
 *      route, because the user will follow it.
 */

import { NETWORK, RoutingError } from '@/core/pedestrian-router';
import { walkingRoute as routeOnDevice } from '@/core/pedestrian-router';
import { HK_NAV_BASE_URL, HK_NAV_PATHS, TIMEOUTS } from '@/core/config';
import { ApiError, joinUrl, postJson } from '@/core/http';
import { bearingDegrees, distanceMeters, formatDistance } from '@/core/geo';
import { offlineUncoveredMessage, routeSourceFor, routeSourceMode } from '@/core/routing-mode';
import { loadSettings } from '@/core/storage';

/** Reject a GPS fix worse than this; HK high-rises routinely give 50-100 m error. */
export const MAX_ACCURACY_METERS = 50;

export function isFixUsable(fix, maxAccuracyMeters = MAX_ACCURACY_METERS) {
  if (!fix) return false;
  if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return false;
  // (0,0) is the classic "no fix" sentinel. It is in the Atlantic.
  if (Math.abs(fix.latitude) < 0.0001 && Math.abs(fix.longitude) < 0.0001) return false;
  if (Number.isFinite(fix.accuracy) && fix.accuracy > maxAccuracyMeters) return false;
  return true;
}

/** Is this point inside one of the districts bundled with the app? */
export function hasOfflineCoverage(point) {
  if (!point) return false;
  return NETWORK.some(
    (district) =>
      point.latitude >= district.bbox[0] - 0.01 &&
      point.latitude <= district.bbox[2] + 0.01 &&
      point.longitude >= district.bbox[1] - 0.01 &&
      point.longitude <= district.bbox[3] + 0.01
  );
}

export function offlineAreas() {
  return NETWORK.map((district) => district.id);
}

/**
 * Plan a walking route.
 *
 * @param {{latitude:number, longitude:number}} origin
 * @param {{latitude:number, longitude:number}} destination
 * @param {{language?: string, profileId?: string}} options
 */
export async function walkingRoute(origin, destination, options = {}) {
  const language = options.language ?? 'yue';

  // The caller may pass a mode (diagnostics, tests); otherwise honour the stored
  // setting so every screen behaves the same without threading it through.
  const mode = routeSourceMode(options.routingMode ?? (await loadSettings()).routingMode);

  const originCovered = hasOfflineCoverage(origin);
  const destinationCovered = hasOfflineCoverage(destination);
  const source = routeSourceFor(mode, { originCovered, destinationCovered });

  // The user explicitly chose the offline map and it does not reach here. Say so
  // with the setting named, instead of quietly calling the server: silently
  // overriding a privacy/connectivity choice is worse than failing.
  if (source === 'offline-uncovered') {
    throw new RoutingError(offlineUncoveredMessage(offlineAreas()), {
      code: 'outside_coverage',
      retryable: false,
    });
  }

  if (source === 'offline') {
    try {
      const plan = routeOnDevice(origin, destination, {
        profileId: options.profileId ?? 'stepFree',
        language,
      });
      return { ...normalise(plan), routingMode: mode, routingSource: 'offline' };
    } catch (error) {
      // A no-route or poor-fix result from the surveyed network is more
      // trustworthy than anything the stub server will say, so report it rather
      // than silently downgrading to a worse source.
      if (error instanceof RoutingError) throw error;
      // Anything else is a bug. In 'auto' fall through so the user still gets
      // something; in 'offline' they asked for no network, so surface it.
      if (mode === 'offline') throw error;
    }
  }

  const fromServer = await routeViaServer(origin, destination, language, options);
  return { ...fromServer, routingMode: mode, routingSource: 'server' };
}

/** Map the on-device result onto the shape the screens already consume. */
function normalise(plan) {
  return {
    steps: plan.steps.map((step, index) => ({
      index,
      instruction: step.instruction,
      distanceMeters: step.metres,
      bearing: step.bearing,
      end: step.end ? { latitude: step.end[1], longitude: step.end[0] } : null,
      isCrossing: Boolean(step.isCrossing),
    })),
    totalDistanceMeters: plan.totalDistanceMeters,
    source: 'offline-csdi',
    avoidsStairs: plan.avoidsStairs,
    disclaimer: null,
    // Extra detail the navigation screen can speak or show.
    hazards: plan.hazards,
    indoorMetres: plan.indoorMetres,
    tactileMetres: plan.tactileMetres,
    lifts: plan.lifts,
    snapMeters: plan.snapMeters,
    destinationSnapMeters: plan.destinationSnapMeters,
    area: plan.area,
  };
}

async function routeViaServer(origin, destination, language, options) {
  const url = joinUrl(HK_NAV_BASE_URL, HK_NAV_PATHS.route);
  const payloads = [
    {
      origin: { lat: origin.latitude, lng: origin.longitude },
      destination: { lat: destination.latitude, lng: destination.longitude },
    },
    {
      from: { latitude: origin.latitude, longitude: origin.longitude },
      to: { latitude: destination.latitude, longitude: destination.longitude },
    },
  ];

  let lastError = null;
  for (const body of payloads) {
    try {
      const data = await postJson(url, body, { timeoutMs: TIMEOUTS.routeMs });
      const instructions = Array.isArray(data?.instructions) ? data.instructions : [];
      if (instructions.length === 0) continue;

      return {
        steps: instructions.map((text, index) => ({
          index,
          instruction: String(text),
          distanceMeters: null,
          bearing: null,
          end: null,
          isCrossing: /cross|過路|斑馬/i.test(String(text)),
        })),
        totalDistanceMeters: data?.distance_meters ?? null,
        source: 'server-stub',
        avoidsStairs: null,
        hazards: [],
        // The server returns fixed example text, so say so rather than letting it
        // read as a surveyed route.
        disclaimer:
          language === 'yue'
            ? '注意：呢個係示範路線，唔係實地測量。'
            : 'Note: this is a demonstration route, not a surveyed one.',
      };
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 422)) break;
    }
  }

  if (options.allowFallback === false) {
    throw lastError ?? new ApiError('Routing unavailable.', { code: 'routing_unavailable' });
  }

  return bearingFallback(origin, destination, language);
}

/** Straight line. Never claims to follow footpaths. */
export function bearingFallback(origin, destination, language = 'yue') {
  const yue = language === 'yue' || language === 'tc';
  const bearing = bearingDegrees(origin, destination);
  const distance = distanceMeters(origin, destination);

  return {
    steps: [
      {
        index: 0,
        instruction: yue
          ? '未能連接導航服務，以下只係直線方向，唔會跟行人路。'
          : 'Routing service unavailable. This is a direct line and does not follow footpaths.',
        distanceMeters: null,
        bearing: null,
        end: null,
        isCrossing: false,
      },
      {
        index: 1,
        instruction: yue
          ? `向${Math.round(bearing)}度方向行${formatDistance(distance, language)}。`
          : `Head ${Math.round(bearing)} degrees for ${formatDistance(distance, language)}.`,
        distanceMeters: distance,
        bearing,
        end: null,
        isCrossing: false,
      },
    ],
    totalDistanceMeters: distance,
    source: 'bearing-fallback',
    avoidsStairs: false,
    hazards: [],
    disclaimer: yue
      ? '呢個係直線方向，唔會跟行人路。'
      : 'This is a direct line and does not follow footpaths.',
  };
}
