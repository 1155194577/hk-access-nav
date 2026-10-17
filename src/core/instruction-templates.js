/**
 * Spoken instruction templates for the on-device pedestrian router.
 *
 * Every template exists in English and Cantonese, selected by the caller's
 * `language`. The Cantonese deliberately follows the server-side router
 * (`backend/routing.py`, `_TURN` / `_TURN_ONTO`): a route should sound the same
 * whether it came from the phone or the server.
 *
 * English is the compatibility surface. These strings are what the app has
 * always said, and existing users and tests depend on the exact wording, so the
 * English side of the table must stay byte-identical to the old inline strings.
 *
 * This module has no dependencies on purpose. `pedestrian-router.js` loads its
 * graph chunks with `require()`, which Node's ESM resolver rejects, so the
 * router itself cannot be imported by the test suite. Keeping the wording in a
 * dependency-free module means it can still be asserted against directly.
 *
 * Placeholders are `{street}`, `{distance}`, `{label}`, `{turn}` and `{body}`.
 */

/**
 * True for a language that should be spoken in Cantonese.
 *
 * `tc` is the app's older tag for the same spoken language: street names were
 * already chosen with it, so the templates follow suit.
 */
export function isCantonese(language) {
  return language === 'yue' || language === 'tc';
}

/**
 * Distance as it should be spoken.
 *
 * Cantonese uses the server's `{n} 米` form, which reads naturally after 大約
 * ("大約100 米"). English keeps the singular/plural wording the app has always
 * used.
 */
export function distanceText(metres, language) {
  if (isCantonese(language)) return `${metres} 米`;
  return metres === 1 ? '1 metre' : `${metres} metres`;
}

/**
 * Instruction templates, keyed by case and then by language.
 *
 * `walkNamed` and `walk` differ only by whether the edge carries a street name;
 * the same split is used for crossings and lifts. `turnWalkNamed` is the
 * special case the router already had: a turn followed by a named continuation
 * is spoken as one sentence instead of two.
 */
export const TEMPLATES = {
  stairs: {
    en: 'There are stairs here, about {distance}.',
    yue: '呢度有樓梯，大約{distance}。',
  },
  liftNamed: {
    en: 'Take the lift at {street}.',
    yue: '喺{street}搭電梯。',
  },
  lift: {
    en: 'Take the lift.',
    yue: '搭電梯。',
  },
  escalator: {
    en: 'Take the escalator.',
    yue: '搭自動扶梯。',
  },
  ramp: {
    en: 'Go up the ramp for about {distance}.',
    yue: '上斜路大約{distance}。',
  },
  crossingNamed: {
    en: 'Cross the road at the {label} on {street}.',
    yue: '喺{street}嘅{label}過馬路。',
  },
  crossing: {
    en: 'Cross the road at the {label}.',
    yue: '喺{label}過馬路。',
  },
  indoor: {
    en: 'Continue inside for about {distance}.',
    yue: '喺室內繼續行大約{distance}。',
  },
  walkNamed: {
    en: 'Continue along {street} for about {distance}.',
    yue: '沿{street}繼續行大約{distance}。',
  },
  walk: {
    en: 'Continue for about {distance}.',
    yue: '繼續行大約{distance}。',
  },
  turnWalkNamed: {
    en: '{turn}, then continue along {street} for about {distance}.',
    yue: '{turn}入{street}，跟住行{distance}。',
  },
  turnThenBody: {
    en: '{turn}. {body}',
    yue: '{turn}。{body}',
  },
};

/**
 * Crossing type, from CSDI `FeatureType`. The numbers are the map's, not ours:
 * 30 signalised, 31 zebra, 32 cautionary, 33 generic.
 */
export const CROSSING_LABEL = {
  30: { en: 'signalised crossing', yue: '交通燈過路處' },
  31: { en: 'zebra crossing', yue: '斑馬線' },
  32: { en: 'cautionary crossing', yue: '無燈號過路處' },
  33: { en: 'crossing', yue: '過路處' },
};

const DEFAULT_CROSSING = 33;

/**
 * Turn wording, keyed by the English phrase `turnWord()` returns.
 *
 * Cantonese follows the server's `_TURN` / `_TURN_ONTO` vocabulary.
 */
export const TURN_WORD = {
  'Bear left': { en: 'Bear left', yue: '微微轉左' },
  'Bear right': { en: 'Bear right', yue: '微微轉右' },
  'Turn left': { en: 'Turn left', yue: '轉左' },
  'Turn right': { en: 'Turn right', yue: '轉右' },
  'Sharp left': { en: 'Sharp left', yue: '急轉左' },
  'Sharp right': { en: 'Sharp right', yue: '急轉右' },
  'Turn around': { en: 'Turn around', yue: '掉頭' },
};

/** Substitute `{name}` placeholders. A missing value becomes an empty string. */
export function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Render one template in one language.
 *
 * Unknown languages fall back to English, matching the router's default.
 */
export function render(caseKey, language, values = {}) {
  const entry = TEMPLATES[caseKey];
  if (!entry) throw new Error(`Unknown instruction template '${caseKey}'.`);
  return fill(entry[isCantonese(language) ? 'yue' : 'en'], values);
}

/** The crossing label for a CSDI FeatureType, in the requested language. */
export function crossingLabel(featureType, language) {
  const entry = CROSSING_LABEL[featureType] || CROSSING_LABEL[DEFAULT_CROSSING];
  return isCantonese(language) ? entry.yue : entry.en;
}

/** The turn phrase for a `turnWord()` result, in the requested language. */
export function turnPhrase(turn, language) {
  if (!turn) return null;
  const entry = TURN_WORD[turn];
  // A future turn word should still be spoken, even if it is only in English.
  if (!entry) return turn;
  return isCantonese(language) ? entry.yue : entry.en;
}
