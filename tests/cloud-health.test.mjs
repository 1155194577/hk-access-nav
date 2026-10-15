/**
 * Tests for the cloud-voice health circuit.
 *
 * This governs whether the app uses the good Cantonese voice (cloud) or the
 * robotic on-device one. Getting it wrong in the impatient direction means a
 * blind user silently loses audio quality for a whole walk; getting it wrong in
 * the tolerant direction means paying a network timeout on every single line
 * while offline. So both edges are pinned here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudHealth } from '../src/core/cloud-health.js';

test('a fresh circuit is available', () => {
  const health = new CloudHealth();
  assert.equal(health.available(0), true);
  assert.equal(health.failures, 0);
});

test('ONE transient failure does not trip the circuit', () => {
  // The original bug: a single dropped request permanently degraded the voice.
  const health = new CloudHealth();
  const stillAvailable = health.recordFailure(0);
  assert.equal(stillAvailable, true);
  assert.equal(health.available(0), true);
  assert.equal(health.tripped, false);
});

test('repeated failures do trip the circuit', () => {
  const health = new CloudHealth();
  health.recordFailure(0);
  const available = health.recordFailure(0);
  assert.equal(available, false);
  assert.equal(health.tripped, true);
  assert.equal(health.available(0), false);
});

test('the circuit re-closes automatically after the cooldown', () => {
  // Without this, a momentary outage would degrade the rest of the session.
  const health = new CloudHealth({ cooldownMs: 60_000 });
  health.recordFailure(0);
  health.recordFailure(0);
  assert.equal(health.available(30_000), false, 'still inside the cooldown');
  assert.equal(health.available(60_000), true, 'cooldown elapsed');
  assert.equal(health.available(120_000), true, 'stays closed');
});

test('a success clears the penalty completely', () => {
  const health = new CloudHealth();
  health.recordFailure(0);
  health.recordSuccess();
  assert.equal(health.failures, 0);
  assert.equal(health.tripped, false);
  assert.equal(health.available(0), true);
});

test('an explicit retry resets immediately, ignoring the cooldown', () => {
  const health = new CloudHealth({ cooldownMs: 600_000 });
  health.recordFailure(0);
  health.recordFailure(0);
  assert.equal(health.available(0), false);

  health.reset();
  assert.equal(health.available(0), true);
  assert.equal(health.failures, 0);
});

test('success right after a trip heals the circuit', () => {
  // The half-open probe succeeds: the app must go back to the good voice.
  const health = new CloudHealth({ cooldownMs: 1000 });
  health.recordFailure(0);
  health.recordFailure(0);
  assert.equal(health.available(1000), true, 'probe allowed');
  health.recordSuccess();
  assert.equal(health.tripped, false);
  assert.equal(health.available(1001), true);
});

test('the failure limit is configurable', () => {
  const strict = new CloudHealth({ failureLimit: 1 });
  assert.equal(strict.recordFailure(0), false, 'one failure is enough when told so');

  const patient = new CloudHealth({ failureLimit: 5 });
  for (let i = 0; i < 4; i += 1) {
    assert.equal(patient.recordFailure(0), true, `failure ${i + 1} should be tolerated`);
  }
  assert.equal(patient.recordFailure(0), false, 'the fifth trips it');
});

test('describe() gives a human-readable state', () => {
  const health = new CloudHealth({ cooldownMs: 30_000 });
  assert.match(health.describe(), /healthy/);
  health.recordFailure(Date.now());
  health.recordFailure(Date.now());
  assert.match(health.describe(), /paused/);
});
