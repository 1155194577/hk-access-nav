/**
 * Cantonese speech synthesis via SiliconFlow (FunAudioLLM/CosyVoice2-0.5B).
 *
 * Contract from the request in the brief, cross-checked against the published
 * TTS guide:
 *   POST {base}/audio/speech
 *   { model, input, voice, response_format: "mp3", instruct?, speed?, gain? }
 *
 * Notes that matter:
 *   - CosyVoice2 does support Cantonese, and the guide explicitly lists it among
 *     the supported Chinese dialects. `instruct` is how we ask for it.
 *   - The guide says not to put spaces in `input`, so text is normalised first.
 *   - The response is raw audio bytes, not JSON.
 */

import { API_KEY, MODELS, SILICONFLOW_BASE_URL, TIMEOUTS } from '../core/config';
import { ApiError, joinUrl, parseError, request } from '../core/http';

/** CosyVoice2 is sensitive to spaces and stray newlines in the input text. */
export function normaliseForSpeech(text) {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[""]/g, '')
    .trim();
}

/** ArrayBuffer -> base64 without blowing the call stack on large clips. */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * @returns {Promise<{ base64: string, mime: string, uri: string }>}
 *   `uri` is a data URI, which expo-audio can play directly.
 */
export async function synthesize(text, opts = {}) {
  const input = normaliseForSpeech(text);
  if (!input) throw new ApiError('Nothing to say.', { code: 'bad_input' });

  const body = {
    model: MODELS.tts,
    input,
    voice: opts.voice ?? MODELS.voice,
    response_format: 'mp3',
    speed: opts.speed ?? 1,
    gain: opts.gain ?? 0,
    // The brief's own example uses this to force Cantonese delivery.
    instruct: opts.instruct ?? '用粤语说这句话',
  };

  const response = await request(
    joinUrl(SILICONFLOW_BASE_URL, '/audio/speech'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(body),
    },
    TIMEOUTS.ttsMs
  );

  if (!response.ok) throw await parseError(response);

  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) {
    throw new ApiError('Speech service returned empty audio.', {
      code: 'empty_audio',
      retryable: true,
    });
  }

  const base64 = arrayBufferToBase64(buffer);
  return { base64, mime: 'audio/mp3', uri: `data:audio/mp3;base64,${base64}` };
}
