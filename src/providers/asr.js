/**
 * Speech-to-text via SiliconFlow (FunAudioLLM/SenseVoiceSmall).
 *
 * Contract verified against the published API reference:
 *   POST {base}/audio/transcriptions
 *   Authorization: Bearer <key>
 *   multipart/form-data: file=<audio>, model=FunAudioLLM/SenseVoiceSmall
 *
 * React Native has no Blob-based File constructor, so the request body is built
 * from a local file descriptor ({ uri, name, type }) which RN's networking layer
 * understands natively.
 */

import { API_KEY, HK_NAV_BASE_URL, HK_NAV_PATHS, MODELS, SILICONFLOW_BASE_URL, TIMEOUTS } from '../core/config';
import { ApiError, joinUrl, parseError, postForm, request } from '../core/http';

function guessAudioFile(uri) {
  const clean = String(uri).split('?')[0];
  const extension = clean.includes('.') ? clean.split('.').pop().toLowerCase() : 'm4a';
  const mime = {
    m4a: 'audio/m4a',
    mp4: 'audio/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aac: 'audio/aac',
    caf: 'audio/x-caf',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
  }[extension];

  return { name: `speech.${extension}`, type: mime ?? 'audio/m4a' };
}

/**
 * @param {string} uri local file uri, file:// path, or http(s) url
 * @returns {Promise<{ text: string, raw: unknown }>}
 */
export async function transcribe(uri) {
  if (!uri) throw new ApiError('No recording to transcribe.', { code: 'bad_input' });

  const form = new FormData();
  const { name, type } = guessAudioFile(uri);

  if (typeof uri === 'string' && /^https?:/i.test(uri)) {
    // Remote audio: fetch it into a Blob first.
    const blobResponse = await request(uri, { method: 'GET' }, TIMEOUTS.asrMs);
    if (!blobResponse.ok) throw await parseError(blobResponse);
    const blob = await blobResponse.blob();
    if (typeof File !== 'undefined') {
      form.append('file', new File([blob], name, { type }));
    } else {
      form.append('file', blob, name);
    }
  } else {
    // Local recording. RN accepts this descriptor object directly.
    form.append('file', { uri, name, type });
  }

  form.append('model', MODELS.asr);

  const response = await request(
    joinUrl(SILICONFLOW_BASE_URL, '/audio/transcriptions'),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
      body: form,
    },
    TIMEOUTS.asrMs
  );

  if (!response.ok) throw await parseError(response);

  const data = await response.json();
  return { text: (data?.text ?? '').trim(), raw: data };
}

/**
 * Transcribe via the HK Nav server.
 *
 * Observed behaviour: this endpoint answers with a fixed transcript and ignores
 * the uploaded audio entirely — it returned "Find the nearest MTR station exit."
 * both with a file and with no file at all. It is therefore used as the DEMO
 * path, where a canned utterance is exactly what we want, and never as the real
 * recogniser. `simulated` records that so callers can label it honestly.
 */
export async function transcribeViaServer(uri) {
  const form = new FormData();
  const { name, type } = guessAudioFile(uri ?? 'demo.m4a');
  if (uri) form.append('file', { uri, name, type });

  const data = await postForm(joinUrl(HK_NAV_BASE_URL, HK_NAV_PATHS.asr), form, {
    timeoutMs: TIMEOUTS.asrMs,
  });

  const text = String(data?.transcript ?? data?.text ?? '').trim();
  if (!text) {
    throw new ApiError('The server returned an empty transcript.', {
      code: 'empty_transcript',
      retryable: true,
    });
  }

  return { text, raw: data, simulated: true };
}

/**
 * Transcribe, preferring the demo server while it is reachable and falling back
 * to real recognition.
 *
 * Ordering is deliberate for this build: the server path always succeeds and
 * keeps the demo deterministic, and SiliconFlow is the safety net if the server
 * is unreachable (it is plain http, which iOS may refuse).
 */
export async function transcribeAny(uri) {
  try {
    return await transcribeViaServer(uri);
  } catch {
    const real = await transcribe(uri);
    return { ...real, simulated: false };
  }
}
