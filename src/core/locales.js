/**
 * Language → BCP-47 locale mapping, and voice ranking.
 *
 * Split out from voices.js so it has NO native imports and can be unit tested on
 * plain Node. The ranking rules decide which of several installed voices gets
 * used, and picking a Mandarin voice to read Cantonese produces speech a user
 * cannot understand — so this is worth pinning down with tests.
 *
 * Relevant codes on iOS:
 *   yue-HK / zh-HK  Cantonese
 *   zh-CN           Mandarin (Simplified)
 *   zh-TW           Mandarin (Traditional)
 *   en-HK           English (Hong Kong)
 *
 * Preference order: exact tag match, then highest quality. Enhanced/Premium
 * voices are the ones that sound good; the compact defaults do not.
 */

export const SPEECH_LANGUAGES = ['yue', 'zh', 'en'];

/** BCP-47 tags to try, best first, for each app language. */
export const LOCALE_PREFERENCE = {
  yue: ['zh-HK', 'yue-HK', 'yue-Hant-HK', 'zh-Hant-HK'],
  zh: ['zh-CN', 'zh-Hans-CN', 'zh-Hans', 'zh-TW'],
  en: ['en-HK', 'en-GB', 'en-US', 'en'],
};

export function localeTagsFor(language) {
  return LOCALE_PREFERENCE[language] ?? LOCALE_PREFERENCE.yue;
}

/** Best-effort primary tag, for when the device cannot be queried. */
export function primaryLocale(language) {
  return localeTagsFor(language)[0];
}

function qualityRank(quality) {
  // expo-speech exposes VoiceQuality.Default | 'Enhanced' | 'Premium'.
  const value = String(quality ?? '').toLowerCase();
  if (value.includes('premium')) return 3;
  if (value.includes('enhanced')) return 2;
  return 1;
}

/** Does this voice plausibly speak the wanted language? */
export function matchesLanguage(voice, tags) {
  const lang = String(voice?.language ?? '').toLowerCase();
  if (!lang) return false;
  if (tags.some((tag) => lang === tag.toLowerCase())) return true;
  // Prefix match: a voice reported as 'zh-Hant-HK' or plain 'zh' still counts.
  return tags.some((tag) => {
    const base = tag.toLowerCase().split('-')[0];
    return lang === base || lang.startsWith(`${base}-`);
  });
}

/** Rank candidates: exact language tag first, then highest quality. */
export function rankVoices(candidates, tags) {
  const exactIndex = (voice) =>
    tags.findIndex((tag) => String(voice?.language ?? '').toLowerCase() === tag.toLowerCase());

  return [...candidates].sort((a, b) => {
    const aExact = exactIndex(a);
    const bExact = exactIndex(b);
    const aScore = aExact === -1 ? 99 : aExact;
    const bScore = bExact === -1 ? 99 : bExact;
    if (aScore !== bScore) return aScore - bScore;
    return qualityRank(b.quality) - qualityRank(a.quality);
  });
}

/** Pick the best voice from a list, or null. Pure. */
export function chooseVoice(voices, language) {
  const tags = localeTagsFor(language);
  const candidates = (voices ?? []).filter((voice) => matchesLanguage(voice, tags));
  return rankVoices(candidates, tags)[0] ?? null;
}

/** Human-readable summary, for the diagnostics screen. */
export function describeVoice(voice) {
  if (!voice) return 'none available';
  return `${voice.name} (${voice.language}, ${voice.quality})`;
}
