/**
 * Conversational assistant via SiliconFlow chat completions.
 *
 *   POST {base}/chat/completions
 *   { model, messages: [{ role, content }], temperature, max_tokens }
 *
 * Two safety decisions, carried over from the design notes of the project's PWA:
 *
 *   1. The model is FORBIDDEN from describing a route in prose. An invented
 *      route can walk a blind user into traffic. It must instead return a
 *      `destination` intent, which is turned into a real routing request.
 *   2. If the reply cannot be parsed, we keep whatever text came back but DROP
 *      any implied action, rather than inventing a destination.
 */

import { API_KEY, LANGUAGE, MODELS, SILICONFLOW_BASE_URL, TIMEOUTS } from '../core/config';
import { ApiError, joinUrl, postJson } from '../core/http';

/** Remembers which candidate model the account actually has, so we retry once at most. */
let resolvedModel = null;

export function getResolvedModel() {
  return resolvedModel ?? MODELS.llmCandidates[0];
}

export function resetResolvedModel() {
  resolvedModel = null;
}

function systemPrompt(language) {
  const cantonese = language === LANGUAGE.speech;
  return [
    'You are the assistant inside a navigation app for blind and visually impaired',
    'pedestrians in Hong Kong. The user cannot see the screen; everything you say may',
    'be read aloud, so your reply must work as pure speech.',
    '',
    'Rules:',
    '1. NEVER describe a route turn by turn in words. A spoken route you invented could',
    '   walk the user into traffic. If the user asks for directions, set "destination"',
    '   to the place they named instead.',
    '2. Reply in ONE or TWO short sentences. No markdown, no lists, no headings, no emoji.',
    '3. Do not use visual words like "see", "look", "the blue sign".',
    '4. If you are unsure, say so plainly. Never guess about a hazard.',
    '5. Hong Kong drives on the LEFT. MTR = 港鐵, minibus = 小巴, tram = 電車,',
    '   Octopus card = 八達通.',
    '6. Never give medical, legal or financial advice.',
    cantonese
      ? '7. Reply in Cantonese (Traditional Chinese, Hong Kong usage).'
      : '7. Reply in English.',
    '',
    'Respond with JSON only:',
    '{"reply": "<what to say aloud>", "destination": "<place name, or null>"}',
  ].join('\n');
}

export function parseReply(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { reply: '', destination: null };

  // Models sometimes wrap JSON in a fenced block despite instructions.
  const unfenced = trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(unfenced);
    const destination =
      typeof parsed.destination === 'string' && parsed.destination.trim()
        ? parsed.destination.trim()
        : null;
    return { reply: String(parsed.reply ?? '').trim(), destination };
  } catch {
    // Keep the prose, drop any action we cannot trust.
    return { reply: trimmed, destination: null };
  }
}

/** Only a missing/renamed model is worth another attempt with a different id. */
function shouldTryNextModel(error) {
  return (
    error instanceof ApiError &&
    (error.status === 400 || error.status === 404) &&
    error.code !== 'network' &&
    error.code !== 'timeout'
  );
}

/**
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {{ language?: string }} opts
 * @returns {Promise<{ reply: string, destination: string|null, model: string }>}
 */
export async function chat(messages, opts = {}) {
  const language = opts.language ?? LANGUAGE.speech;
  const url = joinUrl(SILICONFLOW_BASE_URL, '/chat/completions');

  const candidates = resolvedModel
    ? [resolvedModel, ...MODELS.llmCandidates.filter((m) => m !== resolvedModel)]
    : MODELS.llmCandidates;

  let lastError = null;

  for (const model of candidates) {
    try {
      const data = await postJson(
        url,
        {
          model,
          messages: [{ role: 'system', content: systemPrompt(language) }, ...messages],
          temperature: 0.3,
          max_tokens: 300,
        },
        {
          timeoutMs: TIMEOUTS.llmMs,
          headers: { Authorization: `Bearer ${API_KEY}` },
        }
      );

      const content = data?.choices?.[0]?.message?.content ?? '';
      const parsed = parseReply(content);

      if (!parsed.reply) {
        throw new ApiError('The assistant returned nothing to say.', {
          code: 'empty_reply',
          retryable: true,
        });
      }

      resolvedModel = model;
      return { ...parsed, model };
    } catch (error) {
      lastError = error;
      if (!shouldTryNextModel(error)) throw error;
    }
  }

  throw lastError ?? new ApiError('The assistant is unavailable.', { code: 'unavailable' });
}
