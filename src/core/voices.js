/**
 * On-device voice discovery.
 *
 * The pure language/ranking logic lives in `locales.js` so it can be tested
 * without a device; this module is only the native part: asking iOS what voices
 * it has.
 *
 * Why probe instead of hard-coding a voice: which voices exist depends on the
 * device, the iOS version, and what the user has downloaded in
 * Settings > Accessibility > Spoken Content > Voices. On iOS both Cantonese and
 * Mandarin voices ship, but not always the enhanced ones — and the enhanced ones
 * are the difference between clear speech and robotic speech.
 */

import * as Speech from 'expo-speech';

import { chooseVoice, localeTagsFor, rankVoices, matchesLanguage } from './locales';

export {
  SPEECH_LANGUAGES,
  LOCALE_PREFERENCE,
  localeTagsFor,
  primaryLocale,
  matchesLanguage,
  rankVoices,
  chooseVoice,
  describeVoice,
} from './locales';

/**
 * Ask the device for its voices and pick the best for this language.
 *
 * @returns {Promise<{ voices: object[], candidates: object[], chosen: object|null, tags: string[] }>}
 */
export async function findVoices(language) {
  const tags = localeTagsFor(language);

  let voices = [];
  try {
    voices = (await Speech.getAvailableVoicesAsync()) ?? [];
  } catch {
    // Never fatal: expo-speech still works with a bare language tag.
    voices = [];
  }

  const candidates = voices.filter((voice) => matchesLanguage(voice, tags));

  return {
    voices,
    candidates: rankVoices(candidates, tags),
    chosen: chooseVoice(voices, language),
    tags,
  };
}

/**
 * A voice identifier to pass to Speech.speak, or undefined to let iOS pick.
 *
 * Returning undefined is the right answer when nothing matches: passing a bogus
 * identifier makes iOS read the text with the wrong voice, which for Cantonese
 * means either silence or English-accented nonsense.
 */
export async function pickVoiceIdentifier(language) {
  const { chosen } = await findVoices(language);
  return chosen?.identifier ?? undefined;
}
