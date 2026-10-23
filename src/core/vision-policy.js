/**
 * When is a vision answer worth a second, slower look?
 *
 * Measured on the bundled demo frame (`assets/demo/sidewalk.png`), same prompt.
 * These numbers INVERTED between measurements, which is the whole reason they are
 * dated:
 *
 *   2026-10-16  8B 2-4 s, 32B 12-18 s   -> the small model answered first
 *   2026-10-23  8B 38-45 s, 32B 4-6 s   -> the 32B leads, and answers better
 *
 * The 32B names the tactile paving, the kerb and the railing; the 30B-A3B hedges
 * ("可能係盲人引路磚") where the 32B is definite ("黃色的凸起盲道… 橫向條紋"). Silence
 * while someone stands at a kerb is unacceptable, and an answer that omits the kerb
 * is not good enough either — so the ordering is a measurement to re-take, not a
 * principle. The secondary model is asked only when the primary's answer is not
 * worth trusting: a refusal, an empty reply, or a shrug.
 *
 * This lives apart from the provider on purpose. The rule decides how long a blind
 * user waits, so it must be verifiable without a device, a network, or a bill.
 */

/**
 * Refusals, in the languages the model actually answers in. Cantonese matters:
 * "我無法判斷…" is a refusal, not an observation.
 */
const REFUSAL =
  /cannot tell|can't tell|not sure|unsure|unable to (?:tell|determine|identify)|cannot be determined|無法判斷|無法確定|無法辨識|無法看清|不能確定|未能判斷|唔確定|睇唔清|睇唔到|看不清楚|判斷唔到/i;

/** "無文字可讀" is a complete answer for read-text; it is not a complete description. */
const NO_TEXT = /no text|nothing to read|沒有文字|無文字|冇文字/i;

/** Below this, a *description* has not said anything useful. */
export const MIN_USEFUL_LENGTH = 12;

/**
 * Which source the live hazard scanner may use.
 *
 * The scanner runs on every captured frame, so the billed model is opt-in
 * (Settings › Cloud vision) and off by default. With it off the scanner is
 * deliberately silent: the only free source is a stub that answers the same
 * sentence for every picture, and a warning it invents is a fall risk. Silent is
 * the honest outcome, not a degraded one.
 *
 * @param {boolean} cloudVisionEnabled the user's Settings › Cloud vision switch
 * @returns {string[]} source list for `describe({ sources })`
 */
export function scanSources(cloudVisionEnabled) {
  return cloudVisionEnabled ? ['siliconflow'] : ['server'];
}

/**
 * @param {{description?: string, uncertain?: boolean}} result a normalised vision result
 * @param {{mode?: 'describe'|'identify'|'read-text'|'find-object'}} [opts]
 * @returns {boolean} true when the answer is not worth trusting as it stands
 */
export function looksDoubtful(result, opts = {}) {
  const text = String(result?.description ?? '').trim();
  const mode = opts.mode ?? 'describe';

  if (!text) return true;

  // "I cannot tell" outranks everything: hazards.js already flags it, and it can
  // arrive as a short sentence that would otherwise look complete.
  if (result?.uncertain) return true;
  if (REFUSAL.test(text)) return !(mode === 'read-text' && NO_TEXT.test(text));

  // Short answers are only suspicious for a description. "A bollard." answers
  // "name it", and "無文字可讀" answers "read the text".
  if (mode === 'describe' && text.length < MIN_USEFUL_LENGTH) return true;

  return false;
}

/**
 * Should a failed vision call advance to the next model in the list?
 *
 * The chain used to advance only on 400/404 — model-id drift. That left a worse
 * failure uncovered: a model that still exists but has become slow. On
 * 2026-10-23 the primary answered in 38-45 s against a 20 s budget; every call
 * timed out, and because a timeout carries no HTTP status the chain threw
 * immediately instead of trying the model next to it, which answered in 5 s.
 *
 * So drift advances, and so does a transient failure — timeout, network error,
 * 5xx, or an empty body. A malformed request does not: retrying that would repeat
 * the same mistake against the same wrong payload.
 *
 * @param {{status?: number, code?: string, retryable?: boolean}} error
 * @returns {boolean}
 */
export function shouldTryNextModel(error) {
  if (!error) return false;
  const status = typeof error.status === 'number' ? error.status : null;
  if (status === 400 || status === 404) return true;   // model id drift
  if (status !== null && status >= 500) return true;   // provider-side failure
  if (error.code === 'timeout' || error.code === 'network') return true;
  if (error.code === 'empty_description') return true;
  return error.retryable === true;
}
