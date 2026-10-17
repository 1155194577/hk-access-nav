/**
 * Tests for the bilingual instruction templates.
 *
 * `pedestrian-router.js` cannot be imported here: it loads graph chunks with
 * `require()`, which Node's ESM resolver rejects. That is exactly why the
 * wording lives in `instruction-templates.js` — a dependency-free module the
 * suite can import directly. The router's own behaviour is covered by
 * `on-device-router.test.mjs` and by routing a real Cheung Sha Wan trip.
 *
 * The English side is a compatibility contract: these strings are what the app
 * has always spoken, so every one is pinned verbatim below.
 *
 * Run:  node tests/instruction-templates.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CROSSING_LABEL,
  TEMPLATES,
  TURN_WORD,
  crossingLabel,
  distanceText,
  fill,
  isCantonese,
  render,
  turnPhrase,
} from '../src/core/instruction-templates.js';

const LATIN = /[A-Za-z]/;

// ------------------------------------------------------------- table shape

test('every template exists in both languages', () => {
  for (const [key, entry] of Object.entries(TEMPLATES)) {
    assert.equal(typeof entry.en, 'string', `${key} has no English template`);
    assert.equal(typeof entry.yue, 'string', `${key} has no Cantonese template`);
    assert.ok(entry.en.length > 0, `${key} English template is empty`);
    assert.ok(entry.yue.length > 0, `${key} Cantonese template is empty`);
  }
});

test('translations use the same placeholders as their English originals', () => {
  // A dropped {distance} would silently omit the number from speech.
  const placeholders = (text) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

  for (const [key, entry] of Object.entries(TEMPLATES)) {
    assert.equal(
      placeholders(entry.yue),
      placeholders(entry.en),
      `${key}: Cantonese and English placeholders differ`
    );
  }
});

test('the cases the router emits are all present', () => {
  const required = [
    'stairs',
    'liftNamed',
    'lift',
    'escalator',
    'ramp',
    'crossingNamed',
    'crossing',
    'indoor',
    'walkNamed',
    'walk',
    'turnWalkNamed',
    'turnThenBody',
  ];
  for (const key of required) {
    assert.ok(TEMPLATES[key], `missing template: ${key}`);
  }
});

// --------------------------------------------------------------- English

test('English stays byte-identical to the wording the app shipped', () => {
  // Each assertion is the exact string the old inline template produced.
  assert.equal(
    render('stairs', 'en', { distance: '12 metres' }),
    'There are stairs here, about 12 metres.'
  );
  assert.equal(render('liftNamed', 'en', { street: 'Test Lift' }), 'Take the lift at Test Lift.');
  assert.equal(render('lift', 'en'), 'Take the lift.');
  assert.equal(render('escalator', 'en'), 'Take the escalator.');
  assert.equal(
    render('ramp', 'en', { distance: '15 metres' }),
    'Go up the ramp for about 15 metres.'
  );
  assert.equal(
    render('crossingNamed', 'en', { label: 'signalised crossing', street: 'Test Street' }),
    'Cross the road at the signalised crossing on Test Street.'
  );
  assert.equal(
    render('crossing', 'en', { label: 'signalised crossing' }),
    'Cross the road at the signalised crossing.'
  );
  assert.equal(
    render('indoor', 'en', { distance: '30 metres' }),
    'Continue inside for about 30 metres.'
  );
  assert.equal(
    render('walkNamed', 'en', { street: 'First Street', distance: '100 metres' }),
    'Continue along First Street for about 100 metres.'
  );
  assert.equal(render('walk', 'en', { distance: '100 metres' }), 'Continue for about 100 metres.');
  assert.equal(
    render('turnWalkNamed', 'en', {
      turn: 'Turn left',
      street: 'Second Street',
      distance: '100 metres',
    }),
    'Turn left, then continue along Second Street for about 100 metres.'
  );
  assert.equal(
    render('turnThenBody', 'en', { turn: 'Turn left', body: 'Take the escalator.' }),
    'Turn left. Take the escalator.'
  );
});

test('English distance keeps singular and plural', () => {
  assert.equal(distanceText(1, 'en'), '1 metre');
  assert.equal(distanceText(2, 'en'), '2 metres');
  assert.equal(distanceText(0, 'en'), '0 metres');
  assert.equal(distanceText(100, 'en'), '100 metres');
});

// ------------------------------------------------------------- Cantonese

test('Cantonese instructions are natural sentences, not English with Chinese names', () => {
  const expected = {
    stairs: { values: { distance: '12 米' }, text: '呢度有樓梯，大約12 米。' },
    liftNamed: { values: { street: '測試升降機' }, text: '喺測試升降機搭電梯。' },
    lift: { values: {}, text: '搭電梯。' },
    escalator: { values: {}, text: '搭自動扶梯。' },
    ramp: { values: { distance: '15 米' }, text: '上斜路大約15 米。' },
    crossingNamed: {
      values: { street: '測試街', label: '交通燈過路處' },
      text: '喺測試街嘅交通燈過路處過馬路。',
    },
    crossing: { values: { label: '斑馬線' }, text: '喺斑馬線過馬路。' },
    indoor: { values: { distance: '30 米' }, text: '喺室內繼續行大約30 米。' },
    walkNamed: {
      values: { street: '第一街', distance: '100 米' },
      text: '沿第一街繼續行大約100 米。',
    },
    walk: { values: { distance: '100 米' }, text: '繼續行大約100 米。' },
    turnWalkNamed: {
      values: { turn: '轉左', street: '第二街', distance: '100 米' },
      text: '轉左入第二街，跟住行100 米。',
    },
    turnThenBody: {
      values: { turn: '轉左', body: '搭自動扶梯。' },
      text: '轉左。搭自動扶梯。',
    },
  };

  for (const [key, { values, text }] of Object.entries(expected)) {
    assert.equal(render(key, 'yue', values), text, `${key} Cantonese wording changed`);
    assert.equal(LATIN.test(text), false, `${key} Cantonese contains English`);
  }
});

test('Cantonese distance uses the project\'s {n} 米 form', () => {
  assert.equal(distanceText(1, 'yue'), '1 米');
  assert.equal(distanceText(100, 'yue'), '100 米');
  assert.equal(distanceText(0, 'yue'), '0 米');
  assert.equal(LATIN.test(distanceText(100, 'yue')), false);
});

// --------------------------------------------------------- crossings

test('crossing types come from the map, not from guesswork', () => {
  // 30 signalised, 31 zebra, 32 cautionary, 33 generic.
  assert.equal(crossingLabel(30, 'en'), 'signalised crossing');
  assert.equal(crossingLabel(31, 'en'), 'zebra crossing');
  assert.equal(crossingLabel(32, 'en'), 'cautionary crossing');
  assert.equal(crossingLabel(33, 'en'), 'crossing');

  assert.equal(crossingLabel(30, 'yue'), '交通燈過路處');
  assert.equal(crossingLabel(31, 'yue'), '斑馬線');
  assert.equal(crossingLabel(32, 'yue'), '無燈號過路處');
  assert.equal(crossingLabel(33, 'yue'), '過路處');

  // An unknown FeatureType must still say something safe and generic.
  assert.equal(crossingLabel(99, 'en'), 'crossing');
  assert.equal(crossingLabel(99, 'yue'), '過路處');
});

test('all crossing labels are bilingual and free of English in Cantonese', () => {
  for (const [featureType, entry] of Object.entries(CROSSING_LABEL)) {
    assert.ok(entry.en && entry.yue, `crossing ${featureType} is not bilingual`);
    assert.equal(LATIN.test(entry.yue), false, `crossing ${featureType} Cantonese has English`);
  }
});

// --------------------------------------------------------------- turns

test('turn words follow the server-side Cantonese vocabulary', () => {
  const cases = [
    ['Turn left', '轉左'],
    ['Turn right', '轉右'],
    ['Bear left', '微微轉左'],
    ['Bear right', '微微轉右'],
    ['Sharp left', '急轉左'],
    ['Sharp right', '急轉右'],
    ['Turn around', '掉頭'],
  ];
  for (const [en, yue] of cases) {
    assert.equal(turnPhrase(en, 'en'), en, `${en} changed in English`);
    assert.equal(turnPhrase(en, 'yue'), yue, `${en} mistranslated`);
  }
  assert.equal(turnPhrase(null, 'yue'), null);
});

test('every turn `turnWord()` can return has a translation', () => {
  // turnWord returns exactly these strings; a new one would otherwise leak
  // English into Cantonese speech.
  const possible = [
    'Bear left',
    'Bear right',
    'Turn left',
    'Turn right',
    'Sharp left',
    'Sharp right',
    'Turn around',
  ];
  for (const turn of possible) {
    assert.ok(TURN_WORD[turn], `no Cantonese for '${turn}'`);
    assert.equal(LATIN.test(TURN_WORD[turn].yue), false, `'${turn}' leaks English`);
  }
});

// ------------------------------------------------------------ selection

test('language selects the template, with tc treated as Cantonese', () => {
  assert.equal(isCantonese('yue'), true);
  assert.equal(isCantonese('tc'), true);
  assert.equal(isCantonese('en'), false);
  assert.equal(isCantonese(undefined), false);

  assert.equal(render('walk', 'en', { distance: '10 metres' }), 'Continue for about 10 metres.');
  assert.equal(render('walk', 'yue', { distance: '10 米' }), '繼續行大約10 米。');
  // `tc` is the app's older tag for the same spoken language.
  assert.equal(render('walk', 'tc', { distance: '10 米' }), '繼續行大約10 米。');
  // An unknown language must not crash routing; English is the fallback.
  assert.equal(render('walk', 'fr', { distance: '10 metres' }), 'Continue for about 10 metres.');
});

test('fill leaves unknown placeholders empty rather than printing them', () => {
  assert.equal(fill('A {one} B {two}.', { one: '1' }), 'A 1 B .');
  assert.equal(fill('No placeholders.', {}), 'No placeholders.');
});

test('an unknown template key fails loudly', () => {
  assert.throws(() => render('not-a-case', 'en'), /Unknown instruction template/);
});
