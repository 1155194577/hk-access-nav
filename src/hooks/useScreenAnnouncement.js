/**
 * Announce a screen when it opens.
 *
 * When the app is speaking on its own (no screen reader), a screen that appears
 * silently is indistinguishable from a frozen app, so it speaks its title, its
 * description and — critically — the available actions. A blind user cannot see
 * the buttons; being told the options is the difference between usable and not.
 *
 * When VoiceOver IS running, this deliberately does nothing. VoiceOver narrates
 * the focused element itself and owns swipe / double-tap navigation. If the app
 * also read out a screen script, the user would hear two voices, and ours would
 * talk over the element they had just swiped to. So the announcement is marked
 * `skippable` and the speech service drops it while a screen reader is active.
 *
 * Screen-level repetition is avoided either way: the script fires on first focus
 * only, unless `repeatOnFocus` is set.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { speech, screenScript } from '@/core/speech';
import { useScreenReader } from '@/hooks/useScreenReader';

export function useScreenAnnouncement(title, description, actions = [], options = {}) {
  const { language = 'yue', enabled = true, repeatOnFocus = false } = options;
  const hasAnnounced = useRef(false);
  const screenReaderActive = useScreenReader();

  // Keep the service informed, in an effect rather than during render.
  useEffect(() => {
    if (speech.screenReaderActive !== screenReaderActive) {
      speech.updateConfig({ screenReaderActive });
    }
  }, [screenReaderActive]);

  const announce = useCallback(() => {
    if (!enabled || screenReaderActive) return;
    const script = screenScript(title, description, actions, language);
    // `skippable` is belt-and-braces: the service also checks screenReaderActive.
    speech.announce(script, { priority: 'interrupt', skippable: true });
  }, [title, description, language, enabled, screenReaderActive, actions.join('|')]);

  useFocusEffect(
    useCallback(() => {
      // First focus always announces; later focuses only re-announce if asked, so
      // returning from a modal does not talk over what the user just heard.
      if (!hasAnnounced.current || repeatOnFocus) {
        hasAnnounced.current = true;
        announce();
      }
    }, [announce, repeatOnFocus])
  );

  return announce;
}

/** Exposed so screens can tell whether to render screen-reader-specific UI. */
export { useScreenReader };
