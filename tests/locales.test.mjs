/**
 * Tests for language → locale mapping and voice ranking.
 *
 * These decide which installed voice reads the user's directions. Picking the
 * wrong one is not cosmetic: a Mandarin voice reading Cantonese text is
 * unintelligible to a Cantonese speaker, and a compact voice is hard to follow
 * outdoors. So both the tag preference order and the ranking are pinned here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chooseVoice,
  describeVoice,
  localeTagsFor,
  matchesLanguage,
  primaryLocale,
  rankVoices,
} from '../src/core/locales.js';

const voice = (name, language, quality = 'Default') => ({
  identifier: `com.apple.voice.${name}`,
  name,
  language,
  quality,
});

// --------------------------------------------------------------- tag mapping

test('Cantonese maps to zh-HK first, not yue-HK', () => {
  // zh-HK is what iOS actually reports for Cantonese voices.
  assert.equal(primaryLocale('yue'), 'zh-HK');
  assert.ok(localeTagsFor('yue').includes('yue-HK'), 'should still fall back to yue-HK');
});

test('Mandarin maps to zh-CN and English to en-HK', () => {
  assert.equal(primaryLocale('zh'), 'zh-CN');
  assert.equal(primaryLocale('en'), 'en-HK');
});

test('an unknown language falls back to Cantonese rather than throwing', () => {
  assert.equal(primaryLocale('klingon'), 'zh-HK');
});

// ------------------------------------------------------------ tag matching

test('a voice matches its exact tag', () => {
  assert.equal(matchesLanguage(voice('Sinji', 'zh-HK'), localeTagsFor('yue')), true);
});

test('a regional variant still matches by prefix', () => {
  // 'zh-Hant-HK' is a Cantonese voice even though it is not the first tag.
  assert.equal(matchesLanguage(voice('Meijia', 'zh-Hant-HK'), localeTagsFor('yue')), true);
});

test('a bare language code matches', () => {
  assert.equal(matchesLanguage(voice('Ting-Ting', 'zh'), localeTagsFor('yue')), true);
});

test('a different language does not match', () => {
  assert.equal(matchesLanguage(voice('Samantha', 'en-US'), localeTagsFor('yue')), false);
  assert.equal(matchesLanguage(voice('Thomas', 'fr-FR'), localeTagsFor('zh')), false);
});

test('a voice with no language is rejected rather than assumed', () => {
  assert.equal(matchesLanguage({ identifier: 'x', name: 'x' }, localeTagsFor('yue')), false);
  assert.equal(matchesLanguage(null, localeTagsFor('yue')), false);
});

// ----------------------------------------------------------------- ranking

test('an exact tag beats a less specific one', () => {
  const voices = [voice('Generic', 'zh'), voice('HK', 'zh-HK')];
  const ranked = rankVoices(voices, localeTagsFor('yue'));
  assert.equal(ranked[0].name, 'HK');
});

test('higher quality wins at the same tag', () => {
  const voices = [
    voice('Compact', 'zh-HK', 'Default'),
    voice('Enhanced', 'zh-HK', 'Enhanced'),
    voice('Premium', 'zh-HK', 'Premium'),
  ];
  const ranked = rankVoices(voices, localeTagsFor('yue'));
  assert.equal(ranked[0].name, 'Premium');
  assert.equal(ranked[1].name, 'Enhanced');
  assert.equal(ranked[2].name, 'Compact');
});

test('a nearer tag beats a higher-quality farther tag', () => {
  // Correct language matters more than voice prettiness.
  const voices = [voice('PremiumGeneric', 'zh', 'Premium'), voice('PlainHK', 'zh-HK', 'Default')];
  const ranked = rankVoices(voices, localeTagsFor('yue'));
  assert.equal(ranked[0].name, 'PlainHK');
});

test('rankVoices does not mutate the input array', () => {
  const voices = [voice('A', 'zh'), voice('B', 'zh-HK')];
  const before = voices.map((v) => v.name);
  rankVoices(voices, localeTagsFor('yue'));
  assert.deepEqual(
    voices.map((v) => v.name),
    before,
    'sorting in place would corrupt the caller’s list'
  );
});

// ------------------------------------------------------------ chooseVoice

test('chooseVoice picks the best Cantonese voice on a typical device', () => {
  const installed = [
    voice('Samantha', 'en-US'),
    voice('Ting-Ting', 'zh-CN'),
    voice('Sinji', 'zh-HK', 'Default'),
    voice('Sinji', 'zh-HK', 'Enhanced'),
  ];
  const chosen = chooseVoice(installed, 'yue');
  assert.equal(chosen.language, 'zh-HK');
  assert.equal(chosen.quality, 'Enhanced');
});

test('chooseVoice picks Mandarin when asked for Mandarin', () => {
  const installed = [voice('Sinji', 'zh-HK', 'Enhanced'), voice('Ting-Ting', 'zh-CN', 'Default')];
  assert.equal(chooseVoice(installed, 'zh').name, 'Ting-Ting');
});

test('chooseVoice returns null when no suitable voice is installed', () => {
  // Must NOT fall back to an arbitrary voice: that would read Cantonese with an
  // English voice, which is worse than silence.
  const installed = [voice('Samantha', 'en-US'), voice('Thomas', 'fr-FR')];
  assert.equal(chooseVoice(installed, 'yue'), null);
  assert.equal(chooseVoice([], 'yue'), null);
  assert.equal(chooseVoice(null, 'yue'), null);
});

test('describeVoice is readable and safe on null', () => {
  assert.match(describeVoice(voice('Sinji', 'zh-HK', 'Enhanced')), /Sinji.*zh-HK.*Enhanced/);
  assert.equal(describeVoice(null), 'none available');
});
