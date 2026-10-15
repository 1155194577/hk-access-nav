/**
 * When is a vision answer worth a second, slower look?
 *
 * Measured on the bundled demo frame (`assets/demo/sidewalk.png`), same prompt:
 *
 *   Qwen3-VL-8B-Instruct   2–4 s    correct but terse
 *   Qwen3-VL-32B-Instruct  12–18 s  names the tactile paving, the kerb and the railing
 *
 * Neither number is right on its own. Eighteen seconds of silence while someone
 * stands at a kerb is unacceptable, and an answer that omits the kerb is not good
 * enough either. So the fast model always answers first, and the slow one is asked
 * only when the fast answer is not worth trusting: a refusal, an empty reply, or a
 * shrug. A confident answer is never re-asked — that would pay twice and stay
 * silent longer for the same words.
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
