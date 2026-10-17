/**
 * Where "go home" actually goes.
 *
 * This exists because the feature shipped a lie: the screen announced 屋企 while
 * walking to a random nearby point, and the saved home was only ever used as a
 * gate. The rule worth protecting is that the destination and the label agree —
 * a real coordinate is never announced as simulated, and a stand-in is never
 * announced as your home.
 *
 * Run:  node tests/home-route.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveHomeDestination } from '../src/core/home-route.js';

const HOME = { latitude: 22.3355817, longitude: 114.1539651 };
const FALLBACK = { latitude: 22.2819, longitude: 114.158 };

test('a saved home is the destination, and is not called simulated', () => {
  const r = resolveHomeDestination(HOME, FALLBACK);
  assert.deepEqual(r.destination, HOME);
  assert.equal(r.simulated, false);
  assert.equal(r.spokenName, '屋企');
  assert.equal(r.reason, 'stored');
});

test('the saved home wins over the fallback', () => {
  const r = resolveHomeDestination(HOME, FALLBACK);
  assert.notDeepEqual(r.destination, FALLBACK);
});

test('no saved home falls back, and says so', () => {
  for (const saved of [null, undefined]) {
    const r = resolveHomeDestination(saved, FALLBACK);
    assert.deepEqual(r.destination, FALLBACK);
    assert.equal(r.simulated, true);
    assert.equal(r.spokenName, '屋企（模擬）');
    assert.equal(r.reason, 'no-home-stored');
  }
});

test('destination and label can never disagree', () => {
  // The whole point: simulated === false implies the real name, and vice versa.
  for (const saved of [HOME, null, { latitude: 0, longitude: 0 }]) {
    const r = resolveHomeDestination(saved, FALLBACK);
    assert.equal(r.spokenName, r.simulated ? '屋企（模擬）' : '屋企');
  }
});

test('a stored-but-unusable coordinate is treated as absent', () => {
  const bad = [
    { latitude: 0, longitude: 0 },              // the classic "no fix" sentinel
    { latitude: NaN, longitude: 114.15 },       // half a coordinate
    { latitude: 22.33, longitude: undefined },
    { latitude: '22.33', longitude: '114.15' }, // strings are not numbers
    {},
  ];
  for (const saved of bad) {
    const r = resolveHomeDestination(saved, FALLBACK);
    assert.equal(r.reason, 'home-invalid', `expected home-invalid for ${JSON.stringify(saved)}`);
    assert.equal(r.simulated, true);
    assert.deepEqual(r.destination, FALLBACK);
  }
});

test('extra fields on the stored home are not forwarded', () => {
  // storage keeps accuracy/savedAt alongside the coordinate; routing only needs
  // a point, and leaking the rest into the plan invites confusion later.
  const r = resolveHomeDestination(
    { ...HOME, accuracy: 12, savedAt: 1700000000000 },
    FALLBACK
  );
  assert.deepEqual(Object.keys(r.destination).sort(), ['latitude', 'longitude']);
  assert.deepEqual(r.destination, HOME);
});
