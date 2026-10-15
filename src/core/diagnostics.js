/**
 * Live endpoint diagnostics.
 *
 * The user cannot read a stack trace and cannot see a red console, so "it doesn't
 * work" is the only bug report this app will ever get. This module probes each
 * dependency in isolation and reports a plain-language verdict per endpoint,
 * which is then both displayed and SPOKEN.
 *
 * The three failure modes it exists to separate:
 *
 *   1. Bad key / wrong host        -> 401 from SiliconFlow
 *   2. Model renamed upstream      -> 400/404 naming the model
 *   3. iOS blocking cleartext HTTP -> the routing call fails while HTTPS succeeds
 *
 * (3) is the one that looks like "all the APIs are broken" while the key is
 * perfectly fine: App Transport Security refuses plain http:// unless the host
 * is excepted, and the routing server IS plain http. See app.json.
 */

import {
  API_KEY,
  HK_NAV_BASE_URL,
  HK_NAV_PATHS,
  MODELS,
  SILICONFLOW_BASE_URL,
} from './config';
import { joinUrl } from './http';
import { describeViaSiliconFlow } from '../providers/vision';
import { describeVoice, findVoices, localeTagsFor } from './voices';

/**
 * A valid 64x64 PNG used by the vision check.
 *
 * Two constraints, both learned the hard way: the Qwen3-VL models reject any side
 * under 28 px ("must be larger than 28"), and a hand-built PNG with a bad IDAT
 * checksum is rejected as a broken file. This one is 131 bytes and accepted.
 */
const VISION_PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAAAAACPAi4CAAAASklEQVR4nO3MMREAMAzDwMApfxSF1SUGUI86edPgn7O7u98eAQTQHtMCDKA9pgUYQHtMCzCA9pgWYADtMS3AANpjWoABtMe0AAJ4on2AauLt7IEAAAAASUVORK5CYII=';


/** Plain-language summary for a failure, so the message is actionable. */
function explain(status, bodyText) {
  if (status === 0) {
    const isHttp = bodyText.includes('http://');
    return isHttp
      ? 'Could not connect. If this is iOS, cleartext http:// is blocked by App Transport Security unless the host is excepted in app.json.'
      : 'Could not connect. Check the network.';
  }
  if (status === 401 || status === 403) return 'The API key was rejected.';
  if (status === 404) return 'The model or path does not exist.';
  if (status === 429) return 'Rate limited or out of credit.';
  if (status >= 500) return 'The server had an error.';
  if (status === 400) return 'The request was rejected — often a model name or parameter.';
  return `Unexpected status ${status}.`;
}

async function probe(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    // A step may report a soft problem without being an outright failure.
    if (detail && typeof detail === 'object' && 'text' in detail) {
      return {
        name,
        ok: !detail.warn,
        warn: Boolean(detail.warn),
        status: 200,
        ms: Date.now() - started,
        detail: detail.text,
        hint: detail.hint,
      };
    }
    return { name, ok: true, status: 200, ms: Date.now() - started, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      status: error?.status ?? 0,
      ms: Date.now() - started,
      detail: error?.message ?? String(error),
      hint: explain(error?.status ?? 0, `${error?.message ?? ''} ${name}`),
    };
  }
}

async function checkStatus(res) {
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const error = new Error(text.slice(0, 200) || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return text;
}

const authHeaders = () => ({ Authorization: `Bearer ${API_KEY}` });

/**
 * Run every probe. Resolves to an array of results; never rejects, because a
 * diagnostics run that itself throws is useless.
 */
export async function runDiagnostics(options = {}) {
  const { onProgress } = options;
  const results = [];

  const steps = [
    [
      'On-device voices',
      async () => {
        // Answers "does iOS actually have a Cantonese and a Mandarin voice on
        // THIS device?", which varies by iOS version and what the user has
        // downloaded in Settings > Accessibility > Spoken Content > Voices.
        const [yue, zh] = await Promise.all([findVoices('yue'), findVoices('zh')]);

        const summary = [
          `Cantonese (${localeTagsFor('yue')[0]}): ${describeVoice(yue.chosen)}`,
          `Mandarin (${localeTagsFor('zh')[0]}): ${describeVoice(zh.chosen)}`,
        ].join('\n');

        // Not an error when a voice is missing — expo-speech still falls back to
        // the language tag — but it is worth knowing, so report it as a warning.
        if (!yue.chosen && !zh.chosen) {
          return {
            warn: true,
            text: summary,
            hint: 'No Chinese voice found. Install one in iOS Settings > Accessibility > Spoken Content > Voices, or switch the speech engine to Cloud.',
          };
        }
        return summary;
      },
    ],
    [
      'API key and host',
      async () => {
        const res = await fetch(joinUrl(SILICONFLOW_BASE_URL, '/models'), {
          headers: authHeaders(),
        });
        await checkStatus(res);
        return `${SILICONFLOW_BASE_URL} accepted the key`;
      },
    ],
    [
      `Speech to text (${MODELS.asr})`,
      async () => {
        // Confirm the model is listed rather than burning an upload.
        const res = await fetch(joinUrl(SILICONFLOW_BASE_URL, '/models'), {
          headers: authHeaders(),
        });
        const data = JSON.parse(await checkStatus(res));
        const ids = new Set((data?.data ?? []).map((m) => m.id));
        if (!ids.has(MODELS.asr)) throw Object.assign(new Error(`${MODELS.asr} is not available on this key`), { status: 404 });
        return 'model available';
      },
    ],
    [
      `Voice (${MODELS.voice})`,
      async () => {
        const res = await fetch(joinUrl(SILICONFLOW_BASE_URL, '/audio/speech'), {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODELS.tts,
            input: '測試',
            voice: MODELS.voice,
            response_format: 'mp3',
            instruct: '用粤语说这句话',
          }),
        });
        if (!res.ok) await checkStatus(res);
        const buf = await res.arrayBuffer();
        if (!buf.byteLength) throw new Error('empty audio');
        return `received ${buf.byteLength} bytes of audio`;
      },
    ],
    [
      `Assistant (${MODELS.llmCandidates[0]})`,
      async () => {
        const res = await fetch(joinUrl(SILICONFLOW_BASE_URL, '/chat/completions'), {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODELS.llmCandidates[0],
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            max_tokens: 5,
          }),
        });
        const text = await checkStatus(res);
        const data = JSON.parse(text);
        const reply = data?.choices?.[0]?.message?.content ?? '';
        return `replied: ${String(reply).trim().slice(0, 40)}`;
      },
    ],
    [
      'Routing server',
      async () => {
        // Deliberately a short GET: this is the cleartext-HTTP canary.
        const res = await fetch(joinUrl(HK_NAV_BASE_URL, '/'), { method: 'GET' });
        await checkStatus(res);
        return `${HK_NAV_BASE_URL} reachable`;
      },
    ],
    [
      'Routing query',
      async () => {
        const res = await fetch(joinUrl(HK_NAV_BASE_URL, HK_NAV_PATHS.route), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin: { lat: 22.2819, lng: 114.158 },
            destination: { lat: 22.2775, lng: 114.173 },
          }),
        });
        const text = await checkStatus(res);
        const data = JSON.parse(text);
        const count = Array.isArray(data?.instructions) ? data.instructions.length : 0;
        return `${count} instruction(s) returned`;
      },
    ],
    [
      `Vision (${MODELS.vlm})`,
      async () => {
        // This used to post a fake blob to the HK Nav /api/vlm and report
        // success — but that endpoint answers "success" for anything, so the
        // check could never fail. It now exercises the model the app actually
        // uses, with a real (if tiny) image.
        const result = await describeViaSiliconFlow(VISION_PROBE_PNG, {
          language: 'en',
          mode: 'identify',
          mime: 'image/png',
        });
        if (!result.description) throw new Error('the vision model returned no description');
        return `${result.model} replied in ${result.latencyMs} ms: ${result.description.slice(0, 60)}`;
      },
    ],
  ];

  for (const [name, fn] of steps) {
    onProgress?.(name);
    const result = await probe(name, fn);
    results.push(result);
  }

  return results;
}

/** One spoken sentence summarising a run. Warnings are not counted as failures. */
export function summarise(results) {
  const passed = results.filter((r) => r.ok && !r.warn).length;
  const warned = results.filter((r) => r.ok && r.warn);
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0 && warned.length === 0) {
    return `診斷完成，全部 ${passed} 項正常。`;
  }

  if (failed.length === 0) {
    return `診斷完成，${passed} 項正常，${warned.length} 項要留意：${warned
      .map((w) => w.name)
      .join('、')}。${warned[0].hint ?? ''}`;
  }

  const names = failed.map((f) => f.name).join('、');
  return `診斷完成，${passed} 項正常，${failed.length} 項失敗：${names}。第一項失敗原因：${
    failed[0].hint ?? failed[0].detail
  }`;
}
