/**
 * The routing-source decision, isolated from React Native.
 *
 * The behaviour worth protecting is the one that is easy to get wrong: in
 * 'offline' mode an uncovered trip must NOT fall back to the server. Silently
 * reaching for the network after the user has explicitly asked for the offline
 * map breaks a connectivity and privacy promise, and it does it invisibly.
 *
 * Run:  node tests/routing-mode.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ROUTING_MODES,
  ROUTING_MODE_LABELS,
  describeRoutingMode,
  offlineUncoveredMessage,
  routeSourceFor,
  routeSourceMode,
} from '../src/core/routing-mode.js';

const COVERED = { originCovered: true, destinationCovered: true };
const UNCOVERED = { originCovered: false, destinationCovered: true };
const BOTH_UNCOVERED = { originCovered: false, destinationCovered: false };

test('auto prefers the offline map when both ends are covered', () => {
  assert.equal(routeSourceFor('auto', COVERED), 'offline');
});

test('auto asks the server when either end is outside the map', () => {
  assert.equal(routeSourceFor('auto', UNCOVERED), 'server');
  assert.equal(routeSourceFor('auto', BOTH_UNCOVERED), 'server');
});

test('server mode always uses the server, even when covered', () => {
  assert.equal(routeSourceFor('server', COVERED), 'server');
  assert.equal(routeSourceFor('server', BOTH_UNCOVERED), 'server');
});

test('offline mode uses the map when covered', () => {
  assert.equal(routeSourceFor('offline', COVERED), 'offline');
});

test('offline mode NEVER falls back to the server', () => {
  // This is the whole point of the setting.
  assert.equal(routeSourceFor('offline', UNCOVERED), 'offline-uncovered');
  assert.equal(routeSourceFor('offline', BOTH_UNCOVERED), 'offline-uncovered');
});

test('an unknown stored mode behaves as auto', () => {
  assert.equal(routeSourceFor('nonsense', COVERED), 'offline');
  assert.equal(routeSourceFor(undefined, UNCOVERED), 'server');
  assert.equal(routeSourceFor(null, COVERED), 'offline');
});

test('missing coverage information is treated as uncovered', () => {
  // Guessing "covered" would produce an offline route attempt with no map.
  assert.equal(routeSourceFor('auto', undefined), 'server');
  assert.equal(routeSourceFor('auto', {}), 'server');
  assert.equal(routeSourceFor('offline', {}), 'offline-uncovered');
});

test('routeSourceMode normalises anything to a known mode', () => {
  for (const mode of ROUTING_MODES) assert.equal(routeSourceMode(mode), mode);
  assert.equal(routeSourceMode('SERVER'), 'auto'); // not a value we store
  assert.equal(routeSourceMode(42), 'auto');
});

test('every mode has a label, for the settings screen', () => {
  for (const mode of ROUTING_MODES) {
    assert.ok(ROUTING_MODE_LABELS[mode], `missing label for ${mode}`);
  }
  assert.equal(describeRoutingMode('auto'), ROUTING_MODE_LABELS.auto);
  assert.equal(describeRoutingMode('bogus'), ROUTING_MODE_LABELS.auto);
});

test('the uncovered message names the setting to change', () => {
  const msg = offlineUncoveredMessage(['central', 'tst']);
  // Useful only if it says what to do, not just that something failed.
  assert.match(msg, /伺服器路線/);
  assert.match(msg, /central, tst/);
  assert.match(msg, /Settings/);
});

test('the uncovered message still reads sensibly with no area list', () => {
  const msg = offlineUncoveredMessage();
  assert.match(msg, /Central/);
  assert.match(msg, /Cheung Sha Wan/);
});
