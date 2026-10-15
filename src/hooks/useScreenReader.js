/**
 * Screen-reader (VoiceOver) state.
 *
 * When VoiceOver is on, IT is the narrator. Navigation, element focus and
 * activation all belong to it: swipe right/left moves between elements, and
 * double-tap activates the focused one. An app that also speaks on its own
 * collides with that — two voices, one of them talking over the element the user
 * just swiped to.
 *
 * So this hook exists to let the app get out of the way: screen-level
 * announcements are suppressed while VoiceOver is running, and controls that
 * depend on gestures VoiceOver consumes are replaced with equivalents it can
 * actually perform.
 *
 * Important caveat: `accessibilityLiveRegion` (and its `aria-live` alias) is
 * ANDROID-ONLY in React Native. On iOS, announcing a change is the app's job.
 * That is the other reason this hook matters.
 */

import { AccessibilityInfo } from 'react-native';
import { useEffect, useState } from 'react';

/**
 * @returns {boolean} true while a screen reader (VoiceOver / TalkBack) is on.
 */
export function useScreenReader() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (!cancelled) setActive(Boolean(enabled));
      })
      .catch(() => {
        // If we cannot tell, assume off: suppressing speech would be worse.
      });

    // Fires when the user toggles VoiceOver, including via the accessibility
    // shortcut (triple-click side button), so the app adapts without a restart.
    const subscription = AccessibilityInfo.addEventListener(
      'screenReaderChanged',
      (enabled) => {
        if (!cancelled) setActive(Boolean(enabled));
      }
    );

    return () => {
      cancelled = true;
      subscription?.remove?.();
    };
  }, []);

  return active;
}

/** Imperative check, for non-React code such as the speech service. */
export async function isScreenReaderEnabled() {
  try {
    return Boolean(await AccessibilityInfo.isScreenReaderEnabled());
  } catch {
    return false;
  }
}

/**
 * Move VoiceOver's focus to an element.
 *
 * Used after a navigation change so the user lands on the new screen's heading
 * rather than being left on a control that no longer exists.
 *
 * @param {number|string} handle value from `findNodeHandle` or a nativeID
 */
export function setAccessibilityFocus(handle) {
  if (handle == null) return;
  try {
    AccessibilityInfo.setAccessibilityFocus(handle);
  } catch {
    // Not fatal: focus simply stays where it was.
  }
}

/** Announce something to the screen reader itself (not our TTS). */
export function announceForAccessibility(message) {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    /* ignore */
  }
}

/**
 * Say something, using whichever narrator is in charge.
 *
 * Why this exists: `accessibilityLiveRegion` / `aria-live` is ANDROID-ONLY in
 * React Native. On iOS a changing Text is simply not announced unless the app
 * asks for it. So dynamic content (a transcript appearing, a warning changing)
 * is silent under VoiceOver without this.
 *
 * When VoiceOver is on it must do the announcing — speaking ourselves as well
 * would produce two overlapping voices. When it is off, our own TTS handles it.
 *
 * @param {import('../core/speech').SpeechService} speechService
 * @param {string} text
 * @param {{screenReader: boolean, priority?: 'interrupt'|'normal'|'queue', skippable?: boolean}} opts
 */
export function announceAdaptive(speechService, text, opts) {
  const clean = String(text ?? '').trim();
  if (!clean) return;

  if (opts.screenReader) {
    announceForAccessibility(clean);
    return;
  }

  speechService.announce(clean, {
    priority: opts.priority ?? 'normal',
    skippable: opts.skippable,
  });
}
