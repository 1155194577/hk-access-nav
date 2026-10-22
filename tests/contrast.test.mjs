/**
 * Contrast, measured rather than eyeballed.
 *
 * The palette is only "accessible" if every pair a user actually looks at clears
 * WCAG 2.1. Two failures in the previous colours motivated this file:
 *
 *   white on #2F7BFF               3.89:1   below AA for the 15 px subtitle
 *   border #2A3648 vs background   1.53:1   the control edge was invisible
 *
 * Thresholds used, per WCAG 2.1: 4.5:1 for body text, 3:1 for the boundary of a
 * user-interface component (1.4.11). `button-variants.js` is dependency-free
 * apart from the theme, so this runs in plain Node.
 *
 * Run:  node tests/contrast.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOME_ACTIONS, VARIANTS } from '../src/ui/button-variants.js';
import { Colors } from '../src/ui/theme.js';

const AA_TEXT = 4.5;
const AA_UI = 3.0;

/** WCAG relative luminance. */
function luminance(hex) {
  const m = hex.replace('#', '').match(/../g);
  assert.equal(m.length, 3, `not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = m
    .map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees, for checking that two fills differ by more than shade. */
function hue(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
};

test('every title and subtitle clears AA against its own fill', () => {
  for (const [name, v] of Object.entries(VARIANTS)) {
    const t = contrast(v.text, v.background);
    const s = contrast(v.subtitle, v.background);
    assert.ok(t >= AA_TEXT, `${name}: title is only ${t.toFixed(2)}:1`);
    assert.ok(s >= AA_TEXT, `${name}: subtitle is only ${s.toFixed(2)}:1`);
  }
});

test('text stays readable while the button is pressed', () => {
  for (const [name, v] of Object.entries(VARIANTS)) {
    const r = contrast(v.text, v.pressed);
    assert.ok(r >= AA_TEXT, `${name}: pressed state is only ${r.toFixed(2)}:1`);
  }
});

test('every button is findable by its boundary, not just its fill', () => {
  // WCAG 1.4.11: the edge of a control needs 3:1 against what surrounds it. For a
  // filled button that edge is the fill; for an outlined one it is the border, so
  // the stronger of the two is what has to clear the bar.
  for (const [name, v] of Object.entries(VARIANTS)) {
    const fill = contrast(v.background, Colors.background);
    const edge = contrast(v.border, Colors.background);
    const best = Math.max(fill, edge);
    assert.ok(best >= AA_UI,
      `${name}: neither fill (${fill.toFixed(2)}:1) nor border (${edge.toFixed(2)}:1) ` +
      `separates it from the page`);
  }
});

test('the outlined button has a visible edge', () => {
  const r = contrast(Colors.borderStrong, Colors.background);
  assert.ok(r >= AA_UI, `borderStrong is only ${r.toFixed(2)}:1`);
  // and the old hairline must not creep back in
  assert.ok(contrast(Colors.border, Colors.background) < AA_UI,
    'border is expected to remain decorative only');
});

test('body-level text on the page clears AA', () => {
  assert.ok(contrast(Colors.text, Colors.background) >= AA_TEXT);
  assert.ok(contrast(Colors.textSecondary, Colors.background) >= AA_TEXT);
  assert.ok(contrast(Colors.primaryText, Colors.background) >= AA_TEXT);
});

test('the three home actions differ by hue, not just by shade', () => {
  assert.equal(HOME_ACTIONS.length, 3);
  for (const key of HOME_ACTIONS) {
    assert.ok(VARIANTS[key], `home action "${key}" has no palette`);
  }
  for (let i = 0; i < HOME_ACTIONS.length; i++) {
    for (let j = i + 1; j < HOME_ACTIONS.length; j++) {
      const a = VARIANTS[HOME_ACTIONS[i]].background;
      const b = VARIANTS[HOME_ACTIONS[j]].background;
      const gap = hueGap(a, b);
      assert.ok(gap >= 45,
        `${HOME_ACTIONS[i]} and ${HOME_ACTIONS[j]} are only ${gap.toFixed(0)}deg apart in hue`);
    }
  }
});

test('the bright action fills reach AAA for their ink text', () => {
  for (const key of HOME_ACTIONS) {
    const r = contrast(VARIANTS[key].text, VARIANTS[key].background);
    assert.ok(r >= 7, `${key} is only ${r.toFixed(2)}:1, below AAA`);
  }
});

test('no two variants are identical', () => {
  const seen = new Map();
  for (const [name, v] of Object.entries(VARIANTS)) {
    const key = `${v.background}|${v.text}|${v.border}`;
    assert.ok(!seen.has(key), `${name} is visually identical to ${seen.get(key)}`);
    seen.set(key, name);
  }
});

test('the two documented regressions would still be caught', () => {
  // If someone "restores" the old blue, the subtitle check above fails; keep a
  // direct guard so the reason is obvious in the output.
  assert.ok(contrast('#FFFFFF', '#2F7BFF') < AA_TEXT,
    'the old #2F7BFF was chosen because it failed AA — this pin documents that');
  assert.ok(contrast(Colors.primary, Colors.background) >= AA_UI);
});
