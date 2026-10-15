/**
 * Tests for the pure logic that decides what a blind user is told.
 *
 * These run on plain Node (no device, no React Native), because the functions
 * under test are pure on purpose: the parts of this app that decide whether to
 * say "stairs ahead" or "I cannot tell" must be verifiable without a phone.
 *
 * Run:  node --test tests/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hazardsFromText, hazardSentence, isUrgent } from '../src/core/hazards.js';
import {
  bearingDegrees,
  classifyTurn,
  clockDirection,
  distanceMeters,
  formatDistance,
  walkingSeconds,
} from '../src/core/geo.js';
import { findPlace, nearestPlace, formatPlaceName } from '../src/data/places.js';

// ----------------------------------------------------------------- hazards

test('detects stairs and maps them to the closed hazard code', () => {
  const result = hazardsFromText('There are stairs three steps ahead.');
  assert.equal(result.hazards.length, 1);
  assert.equal(result.hazards[0].code, 'stairs-ahead');
  assert.equal(result.confidence, 'high');
});

test('detects a Cantonese hazard phrase', () => {
  const result = hazardsFromText('前面有樓梯，小心。');
  assert.equal(result.hazards[0].code, 'stairs-ahead');
});

test('an unusable frame yields no hazards and is marked uncertain', () => {
  const result = hazardsFromText('The image is too dark, I cannot tell what is there.');
  assert.equal(result.hazards.length, 0);
  assert.equal(result.uncertain, true);
  assert.equal(result.confidence, 'none');
});

test('a hazard mentioned alongside uncertainty is downgraded, never trusted', () => {
  // This is the dangerous case: the model hedges but still names stairs. We must
  // not present that as confident.
  const result = hazardsFromText('It might be stairs ahead but I cannot tell clearly.');
  assert.equal(result.hazards[0].code, 'stairs-ahead');
  assert.equal(result.confidence, 'low');
});

test('collapses duplicate hazard codes', () => {
  const result = hazardsFromText('A car and a vehicle are ahead.');
  const codes = result.hazards.map((h) => h.code);
  assert.deepEqual(codes, ['moving-vehicle']);
});

test('extracts a spoken distance in metres', () => {
  assert.equal(hazardsFromText('An obstacle 5 meters ahead.').distanceMeters, 5);
  assert.equal(hazardsFromText('有障礙物喺3米前。').distanceMeters, 3);
  assert.equal(hazardsFromText('An obstacle ahead.').distanceMeters, null);
});

test('an unknown distance is treated as urgent rather than assumed safe', () => {
  assert.equal(isUrgent({ code: 'obstacle-ahead' }, null), true);
  assert.equal(isUrgent({ code: 'obstacle-ahead' }, 3), true);
  assert.equal(isUrgent({ code: 'obstacle-ahead' }, 40), false);
});

test('hazard sentence is short and carries the corrective step', () => {
  const hazards = [{ code: 'obstacle-ahead', label: '前方有障礙物' }];
  const sentence = hazardSentence(hazards, 5, 'yue', '請慢低，小心行。');
  assert.match(sentence, /警告/);
  assert.match(sentence, /5米/);
  assert.match(sentence, /請慢低/);
});

// --------------------------------------------------------------------- geo

test('distance between two Hong Kong points is plausible', () => {
  const central = { latitude: 22.2819, longitude: 114.158 };
  const wanchai = { latitude: 22.2775, longitude: 114.173 };
  const d = distanceMeters(central, wanchai);
  // ~1.5 km along the harbourfront.
  assert.ok(d > 1400 && d < 1800, `unexpected distance ${d}`);
});

test('bearing is clockwise from north', () => {
  const origin = { latitude: 22.28, longitude: 114.15 };
  const dueNorth = { latitude: 22.29, longitude: 114.15 };
  const dueEast = { latitude: 22.28, longitude: 114.16 };

  assert.ok(Math.abs(bearingDegrees(origin, dueNorth) - 0) < 1);
  assert.ok(Math.abs(bearingDegrees(origin, dueEast) - 90) < 1);
});

test('clock direction is relative to the user heading, not to north', () => {
  // Facing east, a target to the east is 12 o'clock.
  assert.equal(clockDirection(90, 90), "12 o'clock");
  // Facing east, a target to the north is on the left -> 9 o'clock.
  assert.equal(clockDirection(0, 90), "9 o'clock");
  assert.equal(clockDirection(180, 0), "6 o'clock");
});

test('clock direction refuses to guess without a heading', () => {
  // iOS reports -1 for an unavailable heading; treating that as north would make
  // every instruction wrong, so null is the only safe answer.
  assert.equal(clockDirection(90, null), null);
  assert.equal(clockDirection(null, 90), null);
});

test('distance is rounded to something a person can act on', () => {
  assert.equal(formatDistance(4.2, 'en'), '4 metres');
  assert.equal(formatDistance(43, 'en'), '45 metres');
  assert.equal(formatDistance(1500, 'en'), '1.5 kilometres');
  assert.equal(formatDistance(null, 'en'), 'an unknown distance');
});

test('walking time uses a calm pace', () => {
  assert.equal(Math.round(walkingSeconds(120)), 100);
});

test('turn classification distinguishes a slight bend from a uturn', () => {
  assert.equal(classifyTurn(0, 10), 'straight');
  assert.equal(classifyTurn(0, 30), 'slight');
  assert.equal(classifyTurn(0, 90), 'turn');
  assert.equal(classifyTurn(0, 140), 'sharp');
  assert.equal(classifyTurn(0, 180), 'uturn');
});

// ------------------------------------------------------------------ places

test('finds a place from a natural sentence in English', () => {
  const place = findPlace('I would like to go to the Happy Cha chaan teng in Wan Chai');
  assert.equal(place.id, 'wanchai');
});

test('finds a place from a Cantonese sentence', () => {
  const place = findPlace('我想去中環');
  assert.equal(place.id, 'central');
});

test('an unknown place resolves to nothing rather than a guess', () => {
  // Refusing is the whole point: inventing a coordinate here could walk a blind
  // user into a harbour.
  assert.equal(findPlace('the Happy Cha chaan teng'), null);
  assert.equal(findPlace(''), null);
});

test('the longest alias wins so ambiguous names do not mis-resolve', () => {
  // "kowloon tong" must beat "kowloon park"; a bare "kowloon" matches neither.
  assert.equal(findPlace('kowloon tong').id, 'kowloon-tong');
  assert.equal(findPlace('kowloon park').id, 'kowloon-park');
  assert.equal(findPlace('kowloon'), null);
});

test('nearest place identifies the vicinity', () => {
  const place = nearestPlace({ latitude: 22.2818, longitude: 114.1581 });
  assert.equal(place.id, 'central');
});

test('place names are spoken in the right language', () => {
  const central = findPlace('central');
  assert.equal(formatPlaceName(central, 'yue'), '中環');
  assert.equal(formatPlaceName(central, 'en'), 'Central');
});
