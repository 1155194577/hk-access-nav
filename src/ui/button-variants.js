/**
 * Button palettes, kept separate from the component so they can be measured.
 *
 * `BigButton` imports nothing but this table, and this table imports nothing but
 * the theme — which makes every text/fill pair testable in plain Node, with no
 * React Native, no device and no screenshot. `tests/contrast.test.mjs` asserts the
 * ratios; see `theme.js` for the two failures that motivated the current values.
 *
 * Rules the table obeys, checked by that test:
 *
 *   - title and subtitle reach >= 4.5:1 against their own fill
 *   - every fill reaches >= 3:1 against the page background, so the edge of the
 *     control is perceivable and not only its interior
 *   - `border` is only ever decorative; a control that needs an edge to be found
 *     uses `borderStrong`
 */
import { Colors } from './theme.js';

export const VARIANTS = {
  /** Default call to action. White on #2563EB = 5.17:1. */
  primary: {
    background: Colors.primary,
    pressed: Colors.primaryPressed,
    border: Colors.primary,
    text: '#FFFFFF',
    subtitle: '#FFFFFF',
  },
  /** Neutral, outlined. The edge is what makes it findable: 7.27:1. */
  secondary: {
    background: Colors.surfaceRaised,
    pressed: Colors.surface,
    border: Colors.borderStrong,
    text: Colors.text,
    subtitle: Colors.textSecondary,
  },
  /** Home action 1 — cyan. Ink on fill = 15.00:1. */
  mtr: {
    background: Colors.actionMtr,
    pressed: Colors.actionMtrPressed,
    border: Colors.ink,
    text: Colors.ink,
    subtitle: Colors.ink,
  },
  /** Home action 2 — amber. 11.86:1. */
  home: {
    background: Colors.actionHome,
    pressed: Colors.actionHomePressed,
    border: Colors.ink,
    text: Colors.ink,
    subtitle: Colors.ink,
  },
  /** Home action 3 — violet. 10.14:1. */
  camera: {
    background: Colors.actionCamera,
    pressed: Colors.actionCameraPressed,
    border: Colors.ink,
    text: Colors.ink,
    subtitle: Colors.ink,
  },
  /** Destructive. White on #C62828 = 6.30:1. */
  danger: {
    background: Colors.dangerFill,
    pressed: '#A31F1F',
    border: Colors.dangerFill,
    text: '#FFFFFF',
    subtitle: '#FFFFFF',
  },
};

/** The three home actions, in order, so the screen cannot drift from the palette. */
export const HOME_ACTIONS = ['mtr', 'home', 'camera'];
