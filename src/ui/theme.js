/**
 * Visual theme.
 *
 * Two constraints drive these choices, and both come from the actual use case
 * rather than from taste:
 *
 *   1. A dark, near-black background with very high contrast text. The phone is
 *      used outdoors, in glare, often with the user's eyes not on it at all —
 *      but a sighted companion or a partially sighted user may glance at it.
 *   2. Colour is never the only signal. Hazards carry text and a spoken phrase as
 *      well as red, because a user with low colour vision must not lose meaning.
 */

/**
 * Contrast is measured, not eyeballed. Every pair below is asserted in
 * `tests/contrast.test.mjs` against WCAG 2.1: >= 4.5:1 for body text and
 * >= 3:1 for large text and for the boundary of a control.
 *
 * Two failures in the previous palette drove this revision:
 *
 *   white on #2F7BFF              3.89:1   below AA for the 15 px subtitle
 *   border #2A3648 vs background  1.53:1   control edge effectively invisible
 *
 * The fix is not "a brighter colour". Saturated mid-tones cannot carry white
 * text without failing AA; bright fills with near-black text can, and each one
 * measures between 10:1 and 15:1.
 */
export const Colors = {
  background: '#0B1220',
  surface: '#151E2E',
  surfaceRaised: '#1E293B',
  /** Hairline dividers only — far too weak to outline a control. */
  border: '#2A3648',
  /** Outline for any control that relies on its edge to be found. 7.27:1. */
  borderStrong: '#8FA3BF',
  text: '#FFFFFF',
  /** 7.69:1 on the background. */
  textSecondary: '#9AA7BC',
  /** Near-black text for use ON the bright action fills below. */
  ink: '#0B1220',
  /** Primary actions. Darkened from #2F7BFF so white text reaches 5.17:1. */
  primary: '#2563EB',
  primaryPressed: '#1D4ED8',
  /** The same brand blue, lightened for use AS TEXT on the dark background: 10.38:1. */
  primaryText: '#93C5FD',
  /**
   * The three home actions. Bright fills carrying ink text, each >= 10:1.
   * Chosen for hue separation first: cyan ~190deg, amber ~45deg, violet ~270deg.
   */
  actionMtr: '#A5F3FC',
  actionMtrPressed: '#7DE3F4',
  actionHome: '#FFC53D',
  actionHomePressed: '#F5B21F',
  actionCamera: '#C4B5FD',
  actionCameraPressed: '#AD97F5',
  /** Hazards. Paired with text and speech, never used alone. */
  danger: '#FF4D4F',
  dangerSurface: 'rgba(255,77,79,0.18)',
  /** Fill for a destructive button: white text reaches 6.30:1. */
  dangerFill: '#C62828',
  warning: '#FFC53D',
  warningSurface: 'rgba(255,197,61,0.16)',
  success: '#3DD68C',
  /** The AR guidance path. */
  path: '#4DA3FF',
};

export const Spacing = {
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 48,
};

/**
 * Minimum touch target. Apple's HIG says 44pt; this app deliberately goes much
 * larger because the user is often walking, one-handed, and cannot aim.
 */
export const TouchTarget = {
  min: 64,
  primary: 96,
};

export const Radius = {
  small: 8,
  medium: 16,
  large: 24,
  pill: 999,
};

export const Typography = {
  hero: 34,
  title: 26,
  body: 19,
  button: 20,
  caption: 15,
};
