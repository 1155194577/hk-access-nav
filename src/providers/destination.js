/**
 * Turn "I would like to go to the Happy Cha chaan teng" into a coordinate.
 *
 * Resolution order, and the reasoning for it:
 *
 *   1. Local place table. Instant, offline, and — crucially — its coordinates are
 *      audited. No network dependency for the common case.
 *   2. The LLM, but ONLY to extract a place NAME, never to invent coordinates.
 *      A model asked for a latitude will happily produce a plausible number, and
 *      a plausible number is a person walking into a harbour. So the model's job
 *      is strictly "which place did they mean?", and the answer is fed back
 *      through the local table.
 *
 * If neither resolves, we return null and the caller says "I do not know where
 * that is" rather than guessing. That refusal is a feature.
 */

import { chat } from './llm';
import { findPlace, formatPlaceName } from '@/data/places';

export async function resolveDestination(utterance, opts = {}) {
  const language = opts.language ?? 'yue';
  const text = String(utterance ?? '').trim();
  if (!text) return null;

  // 1. Direct hit on the local table.
  const direct = findPlace(text);
  if (direct) return toDestination(direct, language);

  // 2. Ask the assistant which place they meant, then look that name up locally.
  try {
    const { destination } = await chat(
      [
        {
          role: 'user',
          content: `The user said: "${text}". Which single place in Hong Kong are they asking to go to? Reply with the place name only, or the word null if it is not a place.`,
        },
      ],
      { language: 'en' }
    );

    const candidate = String(destination ?? '').trim();
    if (!candidate || /^null$/i.test(candidate)) return null;

    const resolved = findPlace(candidate) ?? findPlace(text);
    if (resolved) return toDestination(resolved, language);

    // The model named a place we have no audited coordinate for. Do not guess.
    return null;
  } catch {
    return null;
  }
}

function toDestination(place, language) {
  return {
    place: {
      latitude: place.latitude,
      longitude: place.longitude,
      accuracy: null,
    },
    /** What to say aloud. */
    spokenName: formatPlaceName(place, language),
    id: place.id,
    name: place.name,
  };
}
