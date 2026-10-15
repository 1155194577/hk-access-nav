# HK Access Nav — mobile

An Expo app that helps blind and visually impaired people navigate Hong Kong.
Voice-first: the app speaks, listens, and warns about obstacles. iOS and Android.

```bash
npm install
cp .env.example .env  # then paste your SiliconFlow key into .env
npx expo start        # then press i for the iOS simulator, or scan with Expo Go
```

## The API key is not in this repository

Speech, language and vision all run on SiliconFlow, and the app calls that API
directly, so it needs a key. The key lives in `mobile/.env`
(`EXPO_PUBLIC_SILICONFLOW_API_KEY=...`), which is gitignored — copy `.env.example`
and fill it in. The dev server must be restarted after changing it, because Expo
inlines `EXPO_PUBLIC_*` values at bundle time.

Without a key the app still starts: voice falls back to the on-device synthesiser,
and the cloud features report "No SiliconFlow API key is configured" instead of an
unexplained 401.

> **Be aware of the limitation.** Inlining keeps the key out of git, but it is still
> inside the shipped bundle, because the client is what makes the call. For anything
> beyond a demo, those calls belong behind a server that proxies the same endpoints
> with the key held server-side.

## Screens

| Route | File | What it does |
| --- | --- | --- |
| `/` | `src/app/index.jsx` | Main menu: Random visit, Go back home, What is this?, Settings |
| `/visit` | `src/app/visit.jsx` | Camera + press-and-hold voice input; resolves a destination and routes |
| `/navigation` | `src/app/navigation.jsx` | AR view: yellow guidance banner, tactile-path overlay, hazard warnings |
| `/what-is-this` | `src/app/what-is-this.jsx` | Describe / Name it / Read text via the camera |
| `/settings` | `src/app/settings.jsx` | Language, cloud voice, haptics, home location, erase data |

## Where the data comes from

Two backends, and it matters which one is trusted for what.

**SiliconFlow** (`api.siliconflow.cn/v1`) — ASR, TTS and the LLM. Needs the API key
in `src/core/config.js`.

| Capability | Model | Endpoint |
| --- | --- | --- |
| Speech to text | `FunAudioLLM/SenseVoiceSmall` | `POST /audio/transcriptions` (multipart) |
| Text to speech | `FunAudioLLM/CosyVoice2-0.5B:alex` | `POST /audio/speech` |
| Assistant | `deepseek-ai/DeepSeek-V4-Flash` | `POST /chat/completions` |
| Vision | `Qwen/Qwen3-VL-8B-Instruct`, escalating to `Qwen/Qwen3-VL-32B-Instruct` | `POST /chat/completions` |

**HK Nav server** (`47.237.92.84:8000`) — authoritative for **routing only**.

> ⚠️ The deployed server is partly stubbed. Probed directly, every endpoint
> answers, but `/api/tts` returns the literal string `"placeholder_audio_base64"`
> and `/api/llm` echoes a canned sentence. `/api/asr` returns the same transcript
> whether or not you send an audio file. So the app does speech and language
> through SiliconFlow and takes only routing from this server.
>
> `/api/vlm` is stubbed too, which matters because it *looks* like it works: it
> returns `{"status":"success","description":"A glass revolving door is 3 steps
> ahead, flanked by metal handrails."}` for a real 480×360 pavement frame, for a
> 1×1 pixel, and for every `mode` and `prompt` — byte-identical. Vision goes to
> SiliconFlow instead, and the stub is only kept as a reachability canary. A source
> that cannot see is marked `trusted: false` and is never allowed to raise a hazard.

The project also has a **different, more elaborate service** (Google Chirp 3 +
Gemini, mounted at `/v1/*`, defaulting to mock mode). It is not in this repository,
it is not what is deployed at the address above, and nothing here calls it. The
paths differ (`/api/*` vs `/v1/*`) and so do the payloads — do not conflate them.

## Design decisions worth knowing before you change things

**Everything spoken goes through one funnel.** `src/core/speech.js` owns priority
(`interrupt` cancels current speech *and clears the queue*), de-duplication, and
repeat. A hazard must never queue behind a screen description, and a stale
instruction delivered after a hazard is worse than no instruction.

**Nothing is guessed.** `src/data/places.js` holds an audited coordinate table.
An unknown place resolves to *nothing* and the app says "I do not know where that
is". The LLM is only ever asked to name a place, never to produce coordinates —
a model asked for a latitude will invent a plausible one, and a plausible one can
be a harbour. The same applies to hazards in both directions: a refusal
(`我無法判斷…`) outranks a hazard keyword, and an absence statement
(`無明顯障礙物`) is not a hazard either — both were real false alarms before
`core/hazards.js` handled negation.

**Uncertainty is spoken, not hidden.** `hazardsFromText` maps description text to
a closed hazard-code set. A hazard mentioned alongside "I cannot tell" is
downgraded to low confidence and the UI says "Not certain — proceed slowly"
rather than presenting it as fact.

**Fallbacks announce themselves.** If routing fails, `bearingFallback` returns a
straight line whose first step *is* the disclaimer, because the user will follow
the instruction regardless.

**Privacy.** The home coordinate and settings live only on the device
(`src/core/storage.js`). No accounts, no server history, nothing logged.

## Demo mode

This build is wired to work with **no GPS**, and the camera screens degrade to a
bundled image, because the iOS Simulator has no camera and indoor GPS is useless:

| Screen | Behaviour |
| --- | --- |
| Random visit | Uses a real GPS fix if there is a usable one, otherwise a **random Hong Kong coordinate**. The transcript comes from the routing server (which ignores the audio and returns a fixed sentence — verified), falling back to real SiliconFlow ASR. A named place in the utterance wins; otherwise a **random destination** is chosen. |
| Go back home | "Home" is a **random point 400–900 m away** from the current position, so the demo always has somewhere to walk to. The real app would use the saved on-device home coordinate (`src/core/storage.js`). |
| What is this? | **Takes a photo** with the back camera (`takePictureAsync`, base64, shutter sound suppressed) and sends it to `Qwen3-VL`. Falls back to the bundled dummy image (`assets/demo/sidewalk.png`, generated by `npm run demo-frame`) when there is no camera or no permission — the Simulator, the web build, or a capture failure — and labels which one it used on screen. Never falls back to the stubbed `/api/vlm`. |

Anything simulated is labelled as such on screen *and* spoken ("注意：位置係模擬嘅"),
because a random coordinate is not the user's position and must never be presented
as one. `src/core/simulate.js` owns that logic and `tests/simulate.test.mjs` pins
the geometry, bounds and clamping.

Regenerate the demo frame with:

```bash
npm run demo-frame
```

## Vision: one press, two models

`providers/vision.js` sends a frame to SiliconFlow's `Qwen/Qwen3-VL-8B-Instruct`
and speaks the answer. Measured on the bundled demo frame with the same prompt:

| Model | Latency | Answer quality |
| --- | --- | --- |
| `Qwen/Qwen3-VL-8B-Instruct` | 2–4 s | correct but terse |
| `Qwen/Qwen3-VL-30B-A3B-Instruct` | ~12 s | fuller, colloquial Cantonese |
| `Qwen/Qwen3-VL-32B-Instruct` | 12–18 s | names the tactile paving, the kerb and the railing |

There is no 27B Qwen3-VL on this key — the sizes are 8B, 30B-A3B and 32B.

Neither end of that table is right on its own: eighteen seconds of silence while
someone stands at a kerb is unacceptable, and an answer that omits the kerb is not
good enough. So `describe({ escalate: true })` takes the fast answer and only pays
for the 32B when the fast one shrugged — an empty reply, a refusal (`我無法判斷…`),
or a two-word shrug. That rule lives in `core/vision-policy.js`, apart from the
provider, because it decides how long a blind user waits; it is unit-tested.

Two consequences worth knowing before changing things:

- **"What is this?" escalates.** One deliberate press can afford ~20 s worst case.
  Live scanning during navigation is a switch instead: **Settings › Cloud vision**,
  off by default. With it off the scanner stays on the free source, which is a stub,
  so it reports no description and no hazards — silence rather than invented
  obstacles. With it on it sends one photo every 6 s or longer
  (`HAZARD.cloudScanIntervalMs`) to Qwen3-VL, billed per photo, and the free source
  is never chosen implicitly.
- **The system prompt is fixed inside the provider.** It leads with fall risks, and
  it was rewritten after the earlier wording — "if you are not sure, say you cannot
  tell" — made the 8B model refuse to describe the demo frame at all.

## Speech: on-device by default

Speech now uses the **iOS built-in voice** (`AVSpeechSynthesizer` via
`expo-speech`) by default. It is offline, instant, needs no key, and on iOS the
enhanced Cantonese/Mandarin voices are clearer than the cloud model.

Set **Settings › Voice** to switch to the cloud voice (SiliconFlow CosyVoice2).
The cloud voice is also the automatic fallback if the device voice fails.

### Cantonese and Mandarin both work

iOS ships voices for both. The app **probes the device** rather than hard-coding
a locale, because which voices exist depends on the iOS version and what the user
has downloaded:

| App language | BCP-47 tags tried, best first |
| --- | --- |
| Cantonese | `zh-HK`, `yue-HK`, `yue-Hant-HK`, `zh-Hant-HK` |
| Mandarin | `zh-CN`, `zh-Hans-CN`, `zh-Hans`, `zh-TW` |
| English | `en-HK`, `en-GB`, `en-US`, `en` |

Note **Cantonese is `zh-HK` on iOS, not `yue-HK`** — `yue-HK` is tried as a
fallback but is not what iOS normally reports.

Ranking prefers an **exact tag match first, then higher quality** — an
Enhanced/Premium voice at a less exact tag loses to a compact voice at the exact
tag, because speaking the right language correctly matters more than timbre. If
no suitable voice is installed the app passes `undefined` and lets iOS decide,
rather than forcing a wrong-voice identifier onto the text.

Run **Settings › Run connection check** to see exactly which voices this device
reports.

### ⚠️ The one real catch: the iOS mute switch

Expo documents that **on a physical iOS device `expo-speech` produces no sound
while the hardware silent switch is on**, and there is no API to override it. The
app sets `useApplicationAudioSession: false` so iOS manages its own session and
ducks other audio correctly, but that does **not** defeat the mute switch.

The cloud voice path plays through `expo-audio` with `playsInSilentMode: true`,
so it *can* sound while muted. That is the one practical reason to pick cloud.

## VoiceOver (iOS narrator mode)

The app is built to work **with** VoiceOver, not alongside it. Standard VoiceOver
navigation applies: **swipe right / left to move between elements, double-tap to
activate the focused one, three-finger swipe to scroll.**

Four things had to change to make that actually work:

**1. The app stops talking when VoiceOver is talking.** VoiceOver narrates the
focused element itself, so if the app also read out a screen script the user would
hear two voices and ours would talk over the element they just swiped to. Screen
announcements are marked `skippable` and dropped while a screen reader is active.
The app detects VoiceOver via `AccessibilityInfo` and adapts live, including when
it is toggled with the accessibility shortcut.

**2. Hazard warnings still fire under VoiceOver.** They are deliberately *not*
skippable. A duplicated fall warning is far better than a missed one. They are
routed to whichever narrator is in charge so the user hears it once, clearly.

**3. "Press and hold to speak" becomes "double-tap to start, double-tap to stop."**
VoiceOver consumes the touch gesture to move focus, so a press-and-hold never
reaches the button — that control is simply unreachable for a VoiceOver user. The
button swaps to a toggle when VoiceOver is detected, and both the label and hint
change to describe the gesture the user can actually make.

**4. Dynamic content is announced explicitly.** `accessibilityLiveRegion` and
`aria-live` are **Android-only** in React Native — on iOS a changing `Text` is not
announced by itself. So the transcript, the vicinity banner and turn-by-turn
instructions call `AccessibilityInfo.announceForAccessibility` when VoiceOver is
on, and the app's own TTS when it is not.

Decorative emoji are hidden from the accessibility tree
(`accessibilityElementsHidden`), otherwise VoiceOver reads "compass" before every
button label.

## Platform notes

- **`Image.resolveAssetSource` does not exist in React Native 0.86.** The file
  `Libraries/Image/resolveAssetSource.js` is internal and is not re-exported from
  the `Image` component, so calling `Image.resolveAssetSource(...)` throws
  `is not a function`. Use `Asset.loadAsync(require(...))` from `expo-asset` and
  read `localUri` — that guarantees the bytes are on disk. See
  `src/data/demo-frame.js`.

- **`expo-camera` has no frame processor** (verified by inspecting the installed
  package: no `onFrame`, no `frameProcessor`, no VisionCamera interop). "Live"
  hazard scanning is therefore `takePictureAsync` polling in
  `src/hooks/useHazardScanner.js`, with the interval measured from the *end* of
  each scan so a slow network cannot build a capture backlog.
- **`expo-camera` is device-only.** The iOS Simulator has no usable camera, so the
  camera screens cannot be tested there. Everything else works.
- **iOS plays `data:audio/mp3;base64,...` directly** — `expo-audio` decodes it to a
  temp file itself. Android has no such support and would need the base64 written
  out with `expo-file-system` first.
- **HTTPS needs Node's TLS stack, not Windows'.** In this environment curl and
  .NET fail every `https://` call with schannel `SEC_E_NO_CREDENTIALS` (0x8009030e),
  while Node's `fetch()` — OpenSSL, not schannel — reaches SiliconFlow in ~0.2 s.
  That is how the ASR, TTS, LLM and VLM calls were verified against the live
  service. If an HTTPS call fails here, retry it through Node before assuming the
  endpoint or the key is broken.

## Verifying a change

```bash
npx expo export --platform web   # full Metro bundle + prerender of every route
npm test                         # all pure-logic suites, no device, no network
node tests/core.test.mjs         # pure logic: hazards, geodesy, place lookup
node tests/reply.test.mjs        # assistant reply parsing
node tests/vision-policy.test.mjs # escalation rule + refusal/absence handling
```

`npm test` runs every suite in one go; the important ones to know about are
`core.test.mjs` (what gets spoken) and `vision-policy.test.mjs` (when a picture is
re-examined by the slow model, and when a refusal or an absence statement must
outrank a hazard keyword).

`node --test` cannot be used here: the test runner spawns children with piped
stdio, which this sandbox refuses. Run the files directly.
