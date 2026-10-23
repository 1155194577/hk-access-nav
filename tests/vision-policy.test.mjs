/**
 * Tests for the two rules that decide what a blind user is told about a picture:
 * when an answer is not worth trusting (core/vision-policy.js), and when a
 * refusal must outrank a hazard keyword (core/hazards.js).
 *
 * Both are pure, so they run on plain Node with no device and no network.
 *
 * Run:  node tests/vision-policy.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { looksDoubtful, scanSources, shouldTryNextModel, MIN_USEFUL_LENGTH } from '../src/core/vision-policy.js';
import { hazardsFromText } from '../src/core/hazards.js';

// ------------------------------------------------------- live scanning policy

test('live scanning stays free unless the user opts into the paid model', () => {
  assert.deepEqual(scanSources(false), ['server']);
  assert.deepEqual(scanSources(true), ['siliconflow']);
});

test('the paid vision model is never selected implicitly', () => {
  // A missing or half-written setting must not start billing per frame.
  for (const value of [undefined, null, 0, '', false]) {
    assert.ok(
      !scanSources(value).includes('siliconflow'),
      `unexpected paid source for ${JSON.stringify(value)}`
    );
  }
});

// ------------------------------------------------------------ escalation rule

test('a confident description is not re-asked', () => {
  const result = {
    description: '你面前有一條黃色的觸感磚，右邊有欄杆，前方有路緣石。',
    uncertain: false,
  };
  assert.equal(looksDoubtful(result), false);
});

test('an empty answer is doubtful', () => {
  assert.equal(looksDoubtful({ description: '' }), true);
  assert.equal(looksDoubtful({}), true);
});

test('a Cantonese refusal is doubtful', () => {
  // This is the exact sentence the 8B model returned for the demo frame when the
  // system prompt told it to say so when unsure.
  assert.equal(
    looksDoubtful({ description: '我無法判斷前方是否有障礙物或危險。請小心前行。', uncertain: false }),
    true
  );
});

test('a short shrug is doubtful for a description', () => {
  assert.equal(looksDoubtful({ description: '路面平整。' }), true);
  assert.ok('路面平整。'.length < MIN_USEFUL_LENGTH);
});

test('a short answer is fine when it names an object', () => {
  assert.equal(looksDoubtful({ description: 'A bollard.' }, { mode: 'identify' }), false);
});

test('"no text" is a complete answer when the task was to read text', () => {
  assert.equal(looksDoubtful({ description: '無文字可讀。' }, { mode: 'read-text' }), false);
  // ...but "I cannot see the text" is still a failure to read it.
  assert.equal(looksDoubtful({ description: '無法辨識文字。' }, { mode: 'read-text' }), true);
});

test('the hazards flag alone is enough to escalate', () => {
  assert.equal(looksDoubtful({ description: '很好，前面無阻礙。', uncertain: true }), true);
});

// ------------------------------------------------- refusal beats a keyword

test('a Cantonese refusal cannot become a high-confidence hazard', () => {
  // Regression: this sentence says the model could NOT judge, yet it matched the
  // 障礙 keyword table and was spoken as a confident "obstacle ahead".
  const result = hazardsFromText('我無法判斷前方是否有障礙物或危險。請小心前行，確保路面平整無障礙。');

  assert.equal(result.uncertain, true);
  assert.notEqual(result.confidence, 'high');
  assert.equal(result.confidence, 'low');
});

test('an English refusal is flagged as uncertain and downgrades the hazard', () => {
  const result = hazardsFromText(
    'There may be stairs ahead, but the image is blurry and I cannot tell.'
  );
  assert.equal(result.uncertain, true);
  assert.equal(result.confidence, 'low');
});

test('a plain hazard without hedging is still high confidence', () => {
  const result = hazardsFromText('前方有樓梯，請小心。');
  assert.equal(result.uncertain, false);
  assert.equal(result.confidence, 'high');
});

// ------------------------------------------ absence beats the keyword table

test('"no obstacles" is not an obstacle', () => {
  // The 8B model's actual answer for the demo frame.
  const result = hazardsFromText('前方地面平坦，無明顯障礙物或凹凸。您正站在一條有黃色觸感磚的行人道上。');
  assert.deepEqual(result.hazards, []);
});

test('absence markers are recognised in both languages', () => {
  for (const text of [
    '沒有樓梯。',
    '地面冇障礙物，可以放心行。',
    '未見有梯級。',
    'The path is clear of obstacles.',
    'There are no steps ahead.',
  ]) {
    assert.deepEqual(hazardsFromText(text).hazards, [], `expected no hazard for: ${text}`);
  }
});

test('a warning ABOUT a real hazard is not treated as absence', () => {
  // 唔 is a negation, but "do not go near the stairs" is a warning about stairs.
  assert.equal(hazardsFromText('唔好行近樓梯。').hazards[0]?.code, 'stairs-ahead');
});

test('absence in one clause does not hide a hazard in the next', () => {
  const result = hazardsFromText('無障礙物，但前方有樓梯。');
  assert.equal(result.hazards.length, 1);
  assert.equal(result.hazards[0].code, 'stairs-ahead');
});

test('a Cantonese 階梯 is recognised as stairs', () => {
  // The 32B model says 階梯 where the table originally only had 樓梯/梯級.
  assert.equal(hazardsFromText('前方有階梯。').hazards[0]?.code, 'stairs-ahead');
});

test('a timeout advances to the next model instead of failing the feature', () => {
  // The regression this exists for: on 2026-10-23 the primary model took 38-45 s
  // against a 20 s budget. A timeout has no HTTP status, so the old 400/404-only
  // rule threw immediately and the feature failed while a working model sat next
  // in the list.
  assert.equal(shouldTryNextModel({ code: 'timeout', retryable: true }), true);
  assert.equal(shouldTryNextModel({ code: 'network' }), true);
  assert.equal(shouldTryNextModel({ status: 503 }), true);
  assert.equal(shouldTryNextModel({ code: 'empty_description' }), true);
});

test('model-id drift still advances the list', () => {
  assert.equal(shouldTryNextModel({ status: 400 }), true);
  assert.equal(shouldTryNextModel({ status: 404 }), true);
});

test('a malformed request does not retry the same payload forever', () => {
  assert.equal(shouldTryNextModel({ status: 422 }), false);
  assert.equal(shouldTryNextModel({ code: 'missing_api_key', retryable: false }), false);
  assert.equal(shouldTryNextModel(null), false);
  assert.equal(shouldTryNextModel(undefined), false);
});
