/**
 * Central configuration.
 *
 * Two backends are in play, and it matters which one is authoritative for what.
 *
 *   SiliconFlow (`api.siliconflow.cn`)
 *     Real ASR / TTS / LLM. Needs an API key. This is what the brief specifies,
 *     and Cantonese TTS genuinely works here.
 *
 *   HK Nav server (`47.237.92.84:8000`)
 *     The team's deployment. Probed live: every endpoint answers, and routing
 *     returns usable instructions, but /api/tts returns a literal
 *     "placeholder_audio_base64" and /api/llm echoes a canned string. So it is
 *     treated as authoritative for ROUTING and as a safety net for vision.
 *
 * NOTE: the project also has a more elaborate service (Google Chirp 3 + Gemini,
 * mounted at /v1/*, defaulting to mock mode). It is not in this repository and it
 * is not what is deployed at the address above, and nothing here calls it. Do not
 * confuse the two: the paths differ (/api/* vs /v1/*) and so do the payloads.
 */

/**
 * SiliconFlow API key.
 *
 * Read from the environment, never written here: this repository is published,
 * and a key in source is a key the whole internet can spend. Put it in
 * `mobile/.env` (`EXPO_PUBLIC_SILICONFLOW_API_KEY=sk-...`, see `.env.example`)
 * and restart the dev server — Expo inlines `EXPO_PUBLIC_*` at bundle time.
 *
 * Note the honest limitation: inlining still puts the key inside the built app,
 * because the client calls SiliconFlow directly. That is a demo affordance, not a
 * security model. Before this ships, those calls belong behind a server that
 * proxies the same endpoints with the key held server-side.
 */
export const API_KEY = process.env.EXPO_PUBLIC_SILICONFLOW_API_KEY ?? '';

/** Mainland endpoint. The docs also publish api.siliconflow.com. */
export const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

/**
 * HK Nav server. Routing is authoritative here.
 *
 * Override with `EXPO_PUBLIC_HK_NAV_BASE_URL` so moving the backend (a new VM, a
 * local test, a tunnel) does not require editing source. Expo inlines
 * `EXPO_PUBLIC_*` at bundle time, so a rebuild is still required after changing
 * it — and a plain-HTTP address also needs an ATS exception in app.json, or iOS
 * blocks every request while curl on the laptop works fine. HTTPS avoids both
 * problems; see docs/IOS-INSTALL.md §7.
 */
export const HK_NAV_BASE_URL =
  process.env.EXPO_PUBLIC_HK_NAV_BASE_URL ?? 'http://47.237.92.84:8000';

/** Live-server paths, as actually observed on the running service. */
export const HK_NAV_PATHS = {
  route: '/api/navigate/route',
  tts: '/api/tts',
  asr: '/api/asr',
  llm: '/api/llm',
  vlm: '/api/vlm',
};

export const MODELS = {
  asr: 'FunAudioLLM/SenseVoiceSmall',
  tts: 'FunAudioLLM/CosyVoice2-0.5B',
  voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
  /**
   * Model ids on SiliconFlow drift, so the LLM client walks this list and
   * remembers whichever one the account actually has.
   *
   * Verified against GET /v1/models on this key: DeepSeek-V4-Flash exists;
   * the "-0731" variant does NOT.
   */
  llmCandidates: [
    'deepseek-ai/DeepSeek-V4-Flash',
    'deepseek-ai/DeepSeek-V3',
  ],
  /**
   * Vision models, verified against GET /v1/models on this key. Qwen2.5-VL does
   * NOT exist on this account, so the original guess would have 404'd.
   *
   * Fastest first, and that ordering is deliberate: measured on this account with
   * the bundled demo frame, the 32B model took 12-18 s per frame against 2-4 s for
   * the 8B one. A blind pedestrian standing at a kerb cannot wait 18 seconds in
   * silence, so the small model answers first. There is no 27B Qwen3-VL: the sizes
   * on this key are 8B, 30B-A3B and 32B.
   *
   * The lister below is the 400/404 fallback chain. `vlmDeep` is the accuracy
   * model, asked only when the fast answer is not worth trusting — see
   * core/vision-policy.js.
   */
  vlmCandidates: [
    'Qwen/Qwen3-VL-8B-Instruct',
    'Qwen/Qwen3-VL-32B-Instruct',
  ],
  vlm: 'Qwen/Qwen3-VL-8B-Instruct',
  /** Read the tactile paving, the kerb and the railing. Slow, so it is escalated to. */
  vlmDeep: 'Qwen/Qwen3-VL-32B-Instruct',
};

/**
 * Spoken language.
 *
 * These are the app's own language keys; the BCP-47 locale for each lives in
 * core/voices.js, which resolves them against the voices the device actually has.
 */
export const LANGUAGE = {
  speech: 'yue',
  asrHint: '粤语',
};

/**
 * How speech is produced.
 *
 *  'device' - AVSpeechSynthesizer via expo-speech. Offline, instant, no key, and
 *             on iOS the enhanced Cantonese/Mandarin voices sound better than the
 *             cloud model. This is the default.
 *  'cloud'  - SiliconFlow CosyVoice2. Needs network. Kept because it works when
 *             the device has no suitable voice installed, but see the silent
 *             switch caveat in core/speech.js.
 */
export const SPEECH_ENGINE = {
  default: 'device',
  options: ['device', 'cloud'],
};

export const TIMEOUTS = {
  /** Speech must feel immediate; a blind user cannot tell "thinking" from "hung". */
  asrMs: 20000,
  ttsMs: 20000,
  llmMs: 25000,
  routeMs: 15000,
  /**
   * One vision call. The fast model answers in 2-4 s and the 32B in 12-18 s, so
   * the budget is per call, not per screen: the escalated call gets its own.
   * Worst realistic case is ~7 s + ~25 s, and only when the fast model shrugged.
   */
  vlmMs: 20000,
  vlmDeepMs: 45000,
};

export const HAZARD = {
  /** Frames per second sent to the vision model while navigating. */
  scanFps: 1,
  /**
   * Minimum gap between scans when the billed model is doing the looking
   * (Settings › Cloud vision). The loop measures from the END of the previous
   * scan, so the model's own 2-4 s latency throttles this further; this floor only
   * stops a spuriously fast reply from turning into a call every second.
   */
  cloudScanIntervalMs: 6000,
  /**
   * Long edge of a scanned frame. Smaller than the one-shot screen: this runs
   * repeatedly, the model only needs enough detail to spot a step or an obstacle,
   * and a smaller frame is both cheaper and faster to upload.
   */
  scanFrameMaxPx: 768,
  /** JPEG quality for scanned frames. Higher costs bandwidth and latency. */
  jpegQuality: 0.5,
  /** Never re-warn about the same obstacle label inside this window. */
  repeatSuppressMs: 8000,
  /** Distance at which an obstacle becomes a spoken warning. */
  warnDistanceMeters: 8,
};

/** Spoken language helpers. */
export function isCantonese(language) {
  return language === 'yue';
}

/**
 * BCP-47 tag for the given language.
 *
 * Cantonese is zh-HK on iOS, not yue-HK. Both are listed in voices.js, which
 * probes the device rather than assuming.
 */
export function speechLocale(language) {
  if (language === 'yue') return 'zh-HK';
  if (language === 'zh') return 'zh-CN';
  return 'en-HK';
}
