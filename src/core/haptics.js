/**
 * Semantic haptics.
 *
 * Vibration is an underused channel for blind navigation. It works when ambient
 * noise drowns out speech, it works with headphones in, and it is private —
 * which matters to a user who does not want a phone loudly announcing their
 * disability on a crowded MTR platform.
 *
 * Patterns are deliberately distinguishable so a user can learn them:
 *
 *   tick     light    "the app heard you" / a screen responded
 *   double   medium   "attention: a turn is coming"
 *   hazard   heavy    "stop, obstacle"          <- the fall-prevention signal
 *   arrived  rising   "you are here"
 *   error    sharp    "something failed"
 *
 * Unlike the web build this replaces, iOS really does have haptics, so these
 * patterns are no longer decorative. Nothing here throws: a rejected haptic must
 * never take down a screen.
 */

import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

let enabled = true;

export function setHapticsEnabled(value) {
  enabled = Boolean(value);
}

export function isHapticsEnabled() {
  return enabled;
}

async function safely(run) {
  if (!enabled) return;
  try {
    await run();
  } catch {
    // Haptics are a nicety; never let them break navigation.
  }
}

/** Light confirmation. */
export function tick() {
  return safely(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** Turn approaching. */
export function double() {
  return safely(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await delay(90);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  });
}

/**
 * Hazard. Strong and repeated, because this is the fall-prevention signal and it
 * has to cut through whatever else the user is feeling.
 */
export function hazard() {
  return safely(async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    await delay(60);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    await delay(70);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  });
}

/** Destination reached. */
export function arrived() {
  return safely(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await delay(70);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await delay(70);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  });
}

/** Failure. */
export function error() {
  return safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

export function success() {
  return safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Recording started / stopped, so the user knows the mic is live. */
export function recordingStart() {
  return safely(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
    await delay(50);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
  });
}

export function recordingStop() {
  return safely(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft));
}

/**
 * Continuous proximity pulses.
 *
 * Blind pedestrians judge distance from a rising repetition rate rather than a
 * spoken number that goes stale the moment it is said. The pulse is backed by
 * the haptic engine's own interval so it keeps time even while JS is busy.
 */
export class ProximityPulse {
  constructor() {
    this.timer = null;
    this.lastCloseness = -1;
  }

  /** @param {number} closeness 0 (far) .. 1 (at target) */
  start(closeness) {
    const clamped = Math.min(1, Math.max(0, closeness));

    // Skip work for imperceptible changes; this is called from a GPS handler.
    if (Math.abs(clamped - this.lastCloseness) < 0.08 && this.timer) return;
    this.lastCloseness = clamped;

    const interval = 900 - clamped * 680; // 900 ms far -> 220 ms close
    const style =
      clamped > 0.75
        ? Haptics.ImpactFeedbackStyle.Heavy
        : clamped > 0.4
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light;

    this.stop();
    this.timer = setInterval(() => {
      void safely(() => Haptics.impactAsync(style));
    }, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastCloseness = -1;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const hapticsSupported = Platform.OS === 'ios' || Platform.OS === 'android';
