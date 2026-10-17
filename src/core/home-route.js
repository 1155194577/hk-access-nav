/**
 * Decide where "go home" should actually go.
 *
 * The feature used to be honest about being a demo and now needs to be honest
 * about being real, so the decision lives in one pure function instead of inline
 * in the navigation screen:
 *
 *   - a saved home is used as-is, and spoken as 屋企
 *   - with no saved home, a nearby point stands in, and BOTH the label and the
 *     `simulated` flag say so
 *
 * The pairing matters. A previous version rendered a random point as
 * 屋企（模擬）, which was at least truthful; the risk in "fixing" it is landing on
 * a saved coordinate while still flagging `simulated: true`, or the reverse —
 * either way the user is told something untrue about where they are walking.
 *
 * Kept dependency-free so it can be tested without React Native or AsyncStorage.
 */

/**
 * @param {{latitude: number, longitude: number} | null | undefined} savedHome
 * @param {{latitude: number, longitude: number}} fallbackPoint  used only when
 *        no usable home is stored
 * @returns {{
 *   destination: {latitude: number, longitude: number},
 *   simulated: boolean,
 *   spokenName: string,
 *   reason: 'stored' | 'no-home-stored' | 'home-invalid'
 * }}
 */
export function resolveHomeDestination(savedHome, fallbackPoint) {
  if (!savedHome) {
    return {
      destination: fallbackPoint,
      simulated: true,
      spokenName: '屋企（模擬）',
      reason: 'no-home-stored',
    };
  }

  // A stored object with a null island or NaN is not a home; treat it as absent
  // rather than routing to the Atlantic or crashing downstream.
  const { latitude, longitude } = savedHome;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    (Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001)
  ) {
    return {
      destination: fallbackPoint,
      simulated: true,
      spokenName: '屋企（模擬）',
      reason: 'home-invalid',
    };
  }

  return {
    destination: { latitude, longitude },
    simulated: false,
    spokenName: '屋企',
    reason: 'stored',
  };
}
