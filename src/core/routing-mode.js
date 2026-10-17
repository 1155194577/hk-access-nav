/**
 * Which routing source answers a request: the surveyed map bundled in the app,
 * or the HK Nav server.
 *
 * These two sources are not equivalent, and the difference is worth exposing to
 * the user rather than hiding:
 *
 *   offline map   Three surveyed districts (Central, Tsim Sha Tsui, Cheung Sha
 *                 Wan). No network, no data cost, no round trip, and works with
 *                 the phone in airplane mode. Outside those districts there is
 *                 no map at all.
 *
 *   server        City-wide, but needs a connection and sends the user's origin
 *                 to the server. On a metered connection or in a tunnel it may
 *                 simply fail.
 *
 *   automatic     The old behaviour: use the offline map when both ends are
 *                 inside it, otherwise ask the server.
 *
 * This module is deliberately dependency-free so the decision can be tested
 * without React Native, AsyncStorage, or a network.
 */

/** Ordered for the settings screen. */
export const ROUTING_MODES = ['auto', 'server', 'offline'];

export const ROUTING_MODE_LABELS = {
  auto: 'Automatic',
  server: 'Server routing',
  offline: 'Offline map',
};

/**
 * Decide the source for one request.
 *
 * @param {string} mode  'auto' | 'server' | 'offline' (anything else -> 'auto')
 * @param {{originCovered: boolean, destinationCovered: boolean}} coverage
 * @returns {'offline' | 'server' | 'offline-uncovered'}
 *   'offline-uncovered' is the one case with no fallback: the user asked for the
 *   offline map, and the offline map does not cover this trip. Callers must
 *   report that rather than silently reaching for the server — silently ignoring
 *   an explicit privacy/connectivity choice is worse than failing.
 */
export function routeSourceFor(mode, { originCovered, destinationCovered } = {}) {
  const chosen = ROUTING_MODES.includes(mode) ? mode : 'auto';
  const covered = Boolean(originCovered && destinationCovered);

  if (chosen === 'offline') return covered ? 'offline' : 'offline-uncovered';
  if (chosen === 'server') return 'server';
  return covered ? 'offline' : 'server';
}

/**
 * Sentence for the user when an offline-only route cannot be planned.
 *
 * Cantonese first, because that is what is spoken, with the English after it for
 * anyone reading the screen. The message names the setting to change: "the map
 * does not cover this" is useless on its own when the fix is one toggle away.
 */
export function offlineUncoveredMessage(areas = []) {
  const list = areas.length ? areas.join(', ') : 'Central, Tsim Sha Tsui, Cheung Sha Wan';
  return (
    `呢個位置唔喺離線地圖範圍（${list}）。` +
    '喺設定轉用「伺服器路線」，或者行去有地圖嘅地方。' +
    ' — This location is outside the offline map. ' +
    'Switch to server routing in Settings, or move into a covered area.'
  );
}

/** Short label for the status line, e.g. "Offline map — Central". */
export function describeRoutingMode(mode) {
  return ROUTING_MODE_LABELS[routeSourceMode(mode)] ?? ROUTING_MODE_LABELS.auto;
}

/** Normalise an arbitrary stored value to a known mode. */
export function routeSourceMode(mode) {
  return ROUTING_MODES.includes(mode) ? mode : 'auto';
}
