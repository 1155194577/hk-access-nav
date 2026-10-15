/**
 * Vision: describe what is in front of the user.
 *
 * ## Which endpoint is actually looking at the image (measured, not assumed)
 *
 * The team's deployed server (`47.237.92.84:8000`, `POST /api/vlm`) is a
 * **stub**. Measured directly: byte-identical text comes back for a real 480x360
 * pavement frame, for a 1x1 pixel, and for every `mode` and `prompt` —
 * "A glass revolving door is 3 steps ahead, flanked by metal handrails."
 *
 * Because `hazardsFromText` maps prose onto hazard codes, that one canned
 * sentence became *two* confident hazard warnings ("stairs ahead", "door ahead")
 * and "What is this?" announced a fabricated obstruction. A vision source that
 * cannot see must therefore never be spoken as fact and must never be allowed to
 * raise a hazard. `normalise()` enforces that with `trusted: false`.
 *
 * The real model is SiliconFlow's `Qwen/Qwen3-VL-8B-Instruct` (verified present on
 * this key, along with the 32B). It reads the bundled demo frame correctly —
 * yellow tactile paving, grey pavement, railing, kerb — in roughly 1.5–7 s and
 * answers in Cantonese. It is the default source for `describe()`.
 *
 * Sizes on this key are 8B, 30B-A3B and 32B; there is no 27B. Measured on the
 * demo frame with the same prompt: 8B ≈ 2–4 s and terse, 30B-A3B ≈ 12 s, 32B
 * ≈ 12–18 s and the most complete. `describe({ escalate: true })` takes the fast
 * answer and only pays for the 32B when the fast one shrugged — the rule lives in
 * `core/vision-policy.js`.
 *
 * Note the model rejects images smaller than 28 px on a side, so any probe image
 * must be at least 64x64.
 *
 * ## Why the system prompt is fixed here
 *
 * It is what stops a paid vision key from becoming an open-ended LLM, and it is
 * what makes the model lead with a fall risk instead of a colour. The caller may
 * shape the *question*, never the system prompt.
 *
 * ## Why the live hazard scanner does not use the paid model
 *
 * `useHazardScanner` runs once per captured frame. The vision model is billed per
 * call, so the scanner passes `sources: ['server']` explicitly, which yields no
 * description and no hazards. Enabling live paid scanning is a deliberate,
 * documented one-line change in that hook, not a default.
 */

import { API_KEY, HK_NAV_BASE_URL, HK_NAV_PATHS, MODELS, SILICONFLOW_BASE_URL, TIMEOUTS } from '../core/config';
import { ApiError, joinUrl, postJson } from '../core/http';
import { hazardsFromText } from '../core/hazards';
import { looksDoubtful } from '../core/vision-policy';

/**
 * The question asked of the model. A bare "describe this" produces prose that is
 * too long to walk with.
 */
const PROMPTS = {
  describe:
    'What is immediately in front of me? Describe it for safe walking, leading with anything I could trip on.',
  identify: 'Name the single object directly in front of me, briefly.',
  'read-text': 'Read aloud any text visible in this image. Just the text, nothing else.',
  'find-object': 'Is there a doorway or entrance in this image? Answer briefly.',
};

/**
 * Fixed system prompt. The wording is load-bearing: the earlier version pivoted
 * on "if you are not sure, say you cannot tell", and the 8B model complied on the
 * demo frame by refusing to describe anything at all. This version asks for what
 * *is* visible, keeps the hazard-first ordering, and still allows an explicit
 * "this part is unclear" instead of a confident guess.
 */
const SYSTEM_PROMPT = [
  'You describe what is in front of a blind pedestrian in Hong Kong.',
  'Start with anything that could cause a fall or collision (steps, kerbs, obstacles, wet floor).',
  'Then say what is actually visible: surfaces, tactile paving, railings.',
  'One or two short spoken sentences. No markdown.',
  'If part of the scene is unclear, say which part, but still describe what you can see.',
  'Never invent a hazard, and never claim a hazard is absent unless you can see the ground clearly.',
].join(' ');

/** Sources `describe()` understands. `server` is the stub; see the header. */
export const VISION_SOURCES = ['siliconflow', 'server'];

const DEFAULT_SOURCES = ['siliconflow'];

function stripDataUri(base64) {
  const value = String(base64 ?? '');
  const comma = value.indexOf(',');
  return comma >= 0 ? value.slice(comma + 1) : value;
}

/**
 * Shape one answer.
 *
 * `trusted: false` short-circuits hazard extraction: an untrusted source cannot
 * raise a warning, because a warning it invents is a fall risk in itself.
 */
function normalise(text, extra = {}) {
  const description = String(text ?? '').trim();
  const trusted = extra.trusted !== false;

  const hazardFields = trusted
    ? hazardsFromText(description, extra.language ?? 'yue')
    : { hazards: [], confidence: 'none', uncertain: true, distanceMeters: null };

  return {
    description,
    ...hazardFields,
    trusted,
    source: extra.source ?? 'unknown',
    model: extra.model ?? 'unknown',
    latencyMs: extra.latencyMs ?? null,
  };
}

/**
 * Describe via the live HK Nav server.
 *
 * Verified stub (see the module header): it answers the same sentence for any
 * input, so results are marked untrusted and are never used for hazards. Kept
 * because it is a useful "is the deployed server reachable" canary.
 */
export async function describeViaServer(imageBase64, opts = {}) {
  const started = Date.now();
  const data = await postJson(
    joinUrl(HK_NAV_BASE_URL, HK_NAV_PATHS.vlm),
    {
      image_base64: stripDataUri(imageBase64),
      prompt: opts.prompt ?? PROMPTS[opts.mode ?? 'describe'],
    },
    { timeoutMs: TIMEOUTS.llmMs }
  );

  const description = data?.description ?? data?.text ?? '';
  if (!description) {
    throw new ApiError('The vision service returned no description.', {
      code: 'empty_description',
      retryable: true,
    });
  }

  return normalise(description, {
    language: opts.language,
    source: 'server-stub',
    model: 'hk-nav-stub',
    trusted: false,
    latencyMs: Date.now() - started,
  });
}

/** Describe via SiliconFlow's vision model. This is the source that sees. */
export async function describeViaSiliconFlow(imageBase64, opts = {}) {
  const started = Date.now();

  // A clone of this repository has no `.env`, so say what is missing instead of
  // letting a 401 read as "the vision model is broken".
  if (!API_KEY) {
    throw new ApiError('No SiliconFlow API key is configured. Copy mobile/.env.example to mobile/.env and restart the dev server.', {
      code: 'missing_api_key',
      retryable: false,
    });
  }

  const language = opts.language ?? 'yue';
  const mime = opts.mime ?? 'image/jpeg';
  const candidates = opts.models ?? MODELS.vlmCandidates;

  const payload = (model) => ({
    model,
    messages: [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT} ${language === 'yue' ? 'Reply in Cantonese.' : 'Reply in English.'}`,
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${stripDataUri(imageBase64)}` },
          },
          { type: 'text', text: opts.prompt ?? PROMPTS[opts.mode ?? 'describe'] },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });

  const ask = async (model, timeoutMs) => {
    const data = await postJson(
      joinUrl(SILICONFLOW_BASE_URL, '/chat/completions'),
      payload(model),
      { timeoutMs, headers: { Authorization: `Bearer ${API_KEY}` } }
    );

    const description = data?.choices?.[0]?.message?.content ?? '';
    if (!description) {
      throw new ApiError('The vision model returned nothing.', {
        code: 'empty_description',
        retryable: true,
      });
    }

    return normalise(description, {
      language,
      source: 'siliconflow',
      model,
      trusted: true,
      latencyMs: Date.now() - started,
    });
  };

  // Vision model ids drift too, so walk the verified list rather than 404 on one.
  let answer = null;
  let lastError = null;
  for (const model of candidates) {
    try {
      answer = await ask(model, opts.timeoutMs ?? TIMEOUTS.vlmMs);
      break;
    } catch (error) {
      lastError = error;
      const tryNext = error instanceof ApiError && (error.status === 400 || error.status === 404);
      if (!tryNext) throw error;
    }
  }

  if (!answer) {
    throw lastError ?? new ApiError('No vision model available.', { code: 'vision_unavailable' });
  }

  // Escalation (opt-in): the fast model answered, but not usefully. Ask the
  // accuracy model once, and only keep its answer if it is actually better. A
  // failure here must not destroy the answer we already have.
  const deep = MODELS.vlmDeep;
  if (opts.escalate && deep && deep !== answer.model && looksDoubtful(answer, opts)) {
    try {
      const deeper = await ask(deep, opts.deepTimeoutMs ?? TIMEOUTS.vlmDeepMs);
      if (!looksDoubtful(deeper, opts)) return deeper;
    } catch {
      // Keep the fast answer; a slow model that failed is not a reason to say nothing.
    }
  }

  return answer;
}

/**
 * Describe a frame.
 *
 * @param {string} imageBase64 raw base64, with or without a `data:` prefix
 * @param {{
 *   mode?: 'describe'|'identify'|'read-text'|'find-object',
 *   language?: 'yue'|'en',
 *   mime?: string,
 *   sources?: string[],   // default ['siliconflow']; add 'server' for the stub
 *   escalate?: boolean,   // ask the 32B model when the fast answer is doubtful
 *   strict?: boolean,     // rethrow instead of returning an "unavailable" result
 * }} opts
 * @returns {Promise<object>} always resolves unless `strict`
 */
export async function describe(imageBase64, opts = {}) {
  if (!imageBase64) {
    throw new ApiError('No image to describe.', { code: 'bad_input' });
  }

  const sources = opts.sources ?? DEFAULT_SOURCES;
  let lastError = null;

  for (const source of sources) {
    try {
      if (source === 'siliconflow') return await describeViaSiliconFlow(imageBase64, opts);
      if (source === 'server') return await describeViaServer(imageBase64, opts);
      throw new ApiError(`Unknown vision source: ${source}`, { code: 'bad_source' });
    } catch (error) {
      lastError = error;
      if (opts.strict) throw error;
    }
  }

  // Nothing that can actually see the image answered. Say so plainly rather than
  // falling back to text that was not derived from the picture.
  return {
    description: '',
    hazards: [],
    confidence: 'none',
    uncertain: true,
    distanceMeters: null,
    trusted: false,
    source: 'unavailable',
    model: 'none',
    latencyMs: null,
    error: lastError?.message ?? 'vision unavailable',
  };
}

export { PROMPTS, SYSTEM_PROMPT };
