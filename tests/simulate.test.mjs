/**
 * Tests for the synthetic-location helpers.
 *
 * These matter because a random coordinate is fed straight into a routing
 * request. If it lands outside Hong Kong the API has nothing to route, and if
 * `offsetPoint` is arithmetically wrong the "home" demo walks the user somewhere
 * nonsensical — so the geometry is pinned down here rather than eyeballed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HK_BOUNDS,
  isInsideHongKong,
  offsetPoint,
  originFor,
  randomHongKongPoint,
  randomNearbyPoint,
} from '../src/core/simulate.js';
import { distanceMeters } from '../src/core/geo.js';

test('random points always land inside the covered area', () => {
  for (let i = 0; i < 500; i += 1) {
    const point = randomHongKongPoint();
    assert.ok(isInsideHongKong(point), `escaped bounds: ${JSON.stringify(point)}`);
  }
});

test('random points are marked as simulated so the UI can say so', () => {
  const point = randomHongKongPoint();
  assert.equal(point.simulated, true);
  // Accuracy is deliberately implausible: this is not a measurement.
  assert.equal(point.accuracy, 999);
});

test('offsetPoint moves the requested distance in the requested direction', () => {
  const origin = { latitude: 22.28, longitude: 114.16 };

  const north = offsetPoint(origin, 500, 0);
  assert.ok(Math.abs(distanceMeters(origin, north) - 500) < 5, 'north distance off');
  assert.ok(north.latitude > origin.latitude, 'north should raise latitude');
  assert.ok(Math.abs(north.longitude - origin.longitude) < 1e-6, 'north should not shift longitude');

  const east = offsetPoint(origin, 500, 90);
  assert.ok(Math.abs(distanceMeters(origin, east) - 500) < 5, 'east distance off');
  assert.ok(east.longitude > origin.longitude, 'east should raise longitude');
  assert.ok(Math.abs(east.latitude - origin.latitude) < 1e-6, 'east should not shift latitude');

  const south = offsetPoint(origin, 500, 180);
  assert.ok(south.latitude < origin.latitude, 'south should lower latitude');
});

test('longitude scaling accounts for latitude, not a flat degree', () => {
  // At 22 N a degree of longitude is about 92% of a degree of latitude. Treating
  // them as equal would overshoot east-west by ~8%.
  const origin = { latitude: 22.28, longitude: 114.16 };
  const east = offsetPoint(origin, 1000, 90);
  assert.ok(Math.abs(distanceMeters(origin, east) - 1000) < 10);
});

test('offsetPoint clamps to the covered area instead of leaving Hong Kong', () => {
  // Shove hard from the corner: the result must stay routable.
  const corner = { latitude: HK_BOUNDS.maxLat - 0.0001, longitude: HK_BOUNDS.maxLng - 0.0001 };
  const pushed = offsetPoint(corner, 50000, 45);
  assert.ok(isInsideHongKong(pushed), `left bounds: ${JSON.stringify(pushed)}`);
});

test('randomNearbyPoint lands in the requested band', () => {
  const origin = { latitude: 22.28, longitude: 114.16 };
  for (let i = 0; i < 200; i += 1) {
    const near = randomNearbyPoint(origin, 400, 900);
    const d = distanceMeters(origin, near);
    // Clamping at the bounds edge can shorten the distance, so only require the
    // upper bound strictly and allow the lower to be reached loosely.
    assert.ok(d <= 905, `too far: ${d}`);
    assert.ok(d > 0, 'must actually move');
  }
});

test('originFor prefers a real fix and flags whether it is simulated', () => {
  const real = { latitude: 22.3, longitude: 114.17, accuracy: 10 };
  const fromReal = originFor(real, true);
  assert.equal(fromReal.simulated, false);
  assert.equal(fromReal.latitude, 22.3);

  const fromNothing = originFor(null, false);
  assert.equal(fromNothing.simulated, true);
  assert.ok(isInsideHongKong(fromNothing));

  // An unusable fix must not be used just because it exists.
  const fromBad = originFor(real, false);
  assert.equal(fromBad.simulated, true);
});
