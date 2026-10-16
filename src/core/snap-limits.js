/**
 * Snap limits, shared by the router and its tests.
 *
 * Snapping is how a coordinate becomes a point on the surveyed network: find the
 * nearest mapped node and route from there. How far a point is *allowed* to snap
 * is a safety decision, not a technical one, so both limits live here to keep the
 * router and the tests reading the same numbers.
 *
 * This module deliberately has no dependencies. `pedestrian-router.js` loads its
 * graph chunks with `require()`, which Node's ESM resolver rejects, so the router
 * itself cannot be imported by the test suite. Keeping the limits dependency-free
 * means they can still be asserted against directly.
 */

/**
 * Origin limit. Snapping the user's position further than this means the fix is
 * bad, not the network: Hong Kong's high-rises routinely give 50-100 m of error,
 * and routing from a bad snap would send the user somewhere they are not.
 */
export const MAX_SNAP_M = 60;

/**
 * Destination limit, and the reason it exists.
 *
 * A far origin snap is a bad GPS fix. A far *destination* snap is different, and
 * worse: the surveyed network simply does not reach there, so the route
 * terminates at the last mapped node and still reports a normal result. The user
 * is then told they have arrived while standing short of the place they asked for.
 *
 * Measured on the bundled Cheung Sha Wan graph, routing from Fortune Estate
 * (幸福邨, 22.33558, 114.15397):
 *
 *   Cheung Sha Wan station   342 m route, ends   7 m from the station  (fine)
 *   Sham Shui Po station    1193 m route, ends  20 m from the station  (fine)
 *   Lai Chi Kok station      801 m route, ends 145 m from the station
 *   Prince Edward station   1876 m route, ends 717 m from the station
 *
 * The Prince Edward case is self-evidently broken: 1876 m is *shorter* than the
 * 1914 m straight line between the two endpoints, which no real walking route can
 * be. That is the signature of a route that stopped early.
 *
 * Refusing is better than a confident false arrival, so exceeding this limit is
 * an error rather than a warning. Callers that genuinely need to reach an
 * unmapped destination should route to a mapped entrance instead.
 */
export const MAX_DEST_SNAP_M = 60;
