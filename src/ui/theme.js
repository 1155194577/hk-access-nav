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

export const Colors = {
  background: '#0B1220',
  surface: '#151E2E',
  surfaceRaised: '#1E293B',
  border: '#2A3648',
  text: '#FFFFFF',
  textSecondary: '#9AA7BC',
  /** Primary actions. High contrast against the dark background. */
  primary: '#2F7BFF',
  primaryPressed: '#1F5FD1',
  /** Hazards. Paired with text and speech, never used alone. */
  danger: '#FF4D4F',
  dangerSurface: 'rgba(255,77,79,0.18)',
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
