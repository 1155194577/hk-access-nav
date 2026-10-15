/**
 * The announcement service: the centre of the app.
 *
 * In a voice-first interface, "what the app just said" IS the primary user-visible
 * state, so it goes through one funnel rather than being scattered across screens
 * as ad-hoc speak() calls. Responsibilities:
 *
 *   1. PRIORITY. A hazard warning must never queue behind a screen description.
 *      `interrupt` cancels current speech and CLEARS the queue, because a stale
 *      instruction delivered after a hazard is worse than no instruction.
 *   2. REPEAT. A user who missed a sentence needs it again on demand. The last
 *      spoken string is retained and can be replayed, bypassing dedupe.
 *   3. DEDUPE. GPS jitter fires the same "continue straight" repeatedly.
 *      Identical consecutive announcements inside a window are suppressed.
 *   4. FALLBACK. SiliconFlow TTS needs a network. When it fails we fall back to
 *      the on-device synthesiser, which is worse but works offline — and offline
 *      is exactly when a user most needs to be told something.
 *   5. NEVER THROW. Every method is safe to call from a render path or an event
 *      handler. A rejected promise here means a user hears nothing.
 */

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as DeviceSpeech from 'expo-speech';

import * as haptics from './haptics';
import { CloudHealth } from './cloud-health';
import { SPEECH_ENGINE, speechLocale } from './config';
import { pickVoiceIdentifier } from './voices';

const DEDUPE_WINDOW_MS = 4000;

export class SpeechService {
  constructor(options = {}) {
    this.language = options.language ?? 'yue';
    this.rate = options.rate ?? 1;
    this.enabled = options.enabled ?? true;
    this.cloudEnabled = options.cloudEnabled ?? true;
    /** 'device' (default) or 'cloud'. See SPEECH_ENGINE in config.js. */
    this.engine = options.engine ?? SPEECH_ENGINE.default;
    this.voice = options.voice ?? null;
    /** Resolved AVSpeechSynthesisVoice identifier, looked up lazily and cached. */
    this.deviceVoice = options.deviceVoice ?? null;
    this.deviceVoiceResolved = false;

    this.last = null;
    this.listeners = new Set();
    this.pending = [];
    this.draining = false;
    this.speaking = false;
    this.player = null;
    this.currentFinish = null;
    /**
     * Tracks whether the good (cloud) voice is usable. See cloud-health.js for
     * why one failure is tolerated and how the circuit re-closes.
     */
    this.cloud = new CloudHealth();
    this.lastError = null;
    this.usingCloud = false;
    /**
     * Set by the app when VoiceOver / TalkBack is running. While true, skippable
     * (screen-level) announcements are suppressed so we do not talk over the
     * screen reader. Hazard warnings still go through.
     */
    this.screenReaderActive = options.screenReaderActive ?? false;

    // playsInSilentMode matters: a phone on silent must still speak, because the
    // user may be relying on the ringer switch being off in public.
    void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
  }

  // ---------------------------------------------------------------- lifecycle

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLast() {
    return this.last;
  }

  isSpeaking() {
    return this.speaking;
  }

  /** True when the last utterance came from a different engine than configured. */
  isUsingFallback() {
    if (this.last == null) return false;
    return this.engine === 'cloud' ? !this.usingCloud : this.usingCloud;
  }

  getStatus() {
    return {
      speaking: this.speaking,
      engine: this.engine,
      /** The AVSpeechSynthesisVoice identifier in use, or null if iOS picks. */
      deviceVoice: this.deviceVoice,
      /** Whether the cloud voice is currently available as a fallback. */
      cloudAvailable: this.cloudEnabled && this.cloud.available(),
      cloudEnabled: this.cloudEnabled,
      cloudFailures: this.cloud.failures,
      /** Which voice produced the last utterance: 'device' or 'cloud'. */
      usingCloud: this.usingCloud,
      screenReaderActive: this.screenReaderActive,
      lastError: this.lastError,
      enabled: this.enabled,
    };
  }

  updateConfig(patch = {}) {
    if (patch.language !== undefined && patch.language !== this.language) {
      this.language = patch.language;
      // A different language means a different voice; force a fresh lookup.
      this.deviceVoice = null;
      this.deviceVoiceResolved = false;
    }
    if (patch.rate !== undefined) this.rate = patch.rate;
    if (patch.voice !== undefined) this.voice = patch.voice;
    if (patch.engine !== undefined) this.engine = patch.engine;
    if (patch.screenReaderActive !== undefined) {
      this.screenReaderActive = Boolean(patch.screenReaderActive);
      // VoiceOver took over the narration: drop anything we had queued so the two
      // do not overlap mid-sentence.
      if (this.screenReaderActive) this.stop();
    }
    if (patch.cloudEnabled !== undefined) {
      this.cloudEnabled = patch.cloudEnabled;
      // Re-enabling is an explicit user request, so clear the penalty.
      this.cloud.reset();
    }
    if (patch.enabled !== undefined) {
      this.enabled = patch.enabled;
      if (!patch.enabled) this.stop();
    }
  }

  dispose() {
    this.stop();
    try {
      this.player?.remove();
    } catch {
      /* already gone */
    }
    this.player = null;
    this.listeners.clear();
  }

  // ------------------------------------------------------------ announcement

  /**
   * @param {string} text
   * @param {{
   *   priority?: 'interrupt'|'normal'|'queue',
   *   onEnd?: () => void,
   *   haptic?: boolean,
   *   onVoice?: (voice: 'device'|'cloud') => void,
   *   skippable?: boolean,
   * }} opts
   */
  announce(text, opts = {}) {
    const clean = String(text ?? '').trim();

    if (!this.enabled || !clean) {
      opts.onEnd?.();
      return;
    }

    /**
     * Stand down while VoiceOver is narrating.
     *
     * VoiceOver already speaks the focused element, and it owns swipe/double-tap
     * navigation. If we also speak the screen script, the user hears two voices
     * and ours talks over the element they just swiped to.
     *
     * Hazard warnings are NOT skippable: they are the fall-prevention signal, and
     * a duplicated warning is far better than a missed one.
     */
    if (opts.skippable && this.screenReaderActive) {
      opts.onEnd?.();
      return;
    }

    const priority = opts.priority ?? 'normal';

    // Dedupe: GPS-driven repetition of the same instruction makes the app feel
    // broken and drowns out anything new.
    if (
      priority !== 'interrupt' &&
      this.last &&
      this.last.text === clean &&
      Date.now() - this.last.at < DEDUPE_WINDOW_MS
    ) {
      opts.onEnd?.();
      return;
    }

    const record = { text: clean, at: Date.now(), priority };
    this.last = record;
    for (const listener of this.listeners) listener(record);

    if (priority === 'interrupt') {
      this.cancelCurrent();
      this.pending = [];
      void this.speakNow(clean, opts);
      return;
    }

    this.pending.push({ text: clean, opts });
    void this.drain();
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) break;
        await this.speakNow(next.text, next.opts);
      }
    } finally {
      this.draining = false;
    }
  }

  async speakNow(text, opts) {
    this.speaking = true;
    try {
      if (opts.haptic !== false) haptics.tick();
      await this.speak(text, opts);
    } catch (error) {
      this.lastError = error?.message ?? 'speech failed';
      // Last resort: never leave the user in silence.
      await this.speakOffline(text, opts).catch(() => {});
    } finally {
      this.speaking = false;
      opts.onEnd?.();
    }
  }

  // ----------------------------------------------------------------- speaking

  async speak(text, opts = {}) {
    if (this.engine === 'cloud') {
      return this.speakCloudOrDevice(text, opts);
    }
    return this.speakDeviceOrCloud(text, opts);
  }

  /**
   * Default path: the on-device synthesiser.
   *
   * Chosen as the default because on iOS the built-in Cantonese and Mandarin
   * voices are both offline and, in practice, clearer than the cloud model — and
   * they cost nothing and start instantly.
   *
   * KNOWN iOS CAVEAT (documented by Expo): on a physical device expo-speech
   * produces no sound while the hardware silent switch is on. There is no API to
   * override that. `useApplicationAudioSession: false` is set so iOS manages its
   * own session and ducks other audio correctly, but it does NOT defeat the mute
   * switch. That is the one real advantage of the cloud path, which plays through
   * expo-audio and can be configured to sound in silent mode.
   */
  async speakDeviceOrCloud(text, opts = {}) {
    try {
      await this.speakOffline(text, opts);
      return;
    } catch (error) {
      this.lastError = error?.message ?? 'device speech failed';
      // Fall through to the cloud voice rather than going silent.
    }
    if (this.cloudEnabled && this.cloud.available()) {
      await this.speakCloud(text, opts);
      return;
    }
    this.usingCloud = false;
    opts.onVoice?.('offline');
  }

  /** Cloud-first path, for when the device has no suitable voice installed. */
  async speakCloudOrDevice(text, opts = {}) {
    if (this.cloudEnabled && this.cloud.available()) {
      try {
        await this.speakCloud(text, opts);
        return;
      } catch (error) {
        this.lastError = error?.message ?? 'cloud tts failed';
        this.cloud.recordFailure();
      }
    }
    this.usingCloud = false;
    opts.onVoice?.('offline');
    await this.speakOffline(text, opts);
  }

  async speakCloud(text, opts = {}) {
    const { synthesize } = await import('../providers/tts');
    const { uri } = await synthesize(text, {
      voice: this.voice ?? undefined,
      speed: this.rate,
    });
    this.cloud.recordSuccess();
    this.usingCloud = true;
    opts.onVoice?.('cloud');
    await this.playDataUri(uri, opts);
  }

  /** True while cloud TTS should be attempted. */
  cloudUsable() {
    return this.cloud.available();
  }

  /**
   * Forget past cloud failures and report whether a synthesis attempt succeeds.
   * Used by the settings screen so "is the good voice working?" has a real answer
   * instead of a guess.
   *
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async retryCloud() {
    this.cloud.reset();
    try {
      const { synthesize } = await import('../providers/tts');
      await synthesize('測試', { voice: this.voice ?? undefined, speed: this.rate });
      this.cloud.recordSuccess();
      return { ok: true };
    } catch (error) {
      // Record enough failures to open the circuit, since this was an explicit
      // check and it failed.
      this.cloud.recordFailure();
      return { ok: false, error: error?.message ?? 'cloud voice failed' };
    }
  }

  /**
   * On-device voice.
   *
   * Rejects on failure so the caller can fall back to the cloud voice instead of
   * leaving the user in silence. (Previously this swallowed every error, so a
   * broken device voice simply said nothing.)
   */
  async speakOffline(text, opts = {}) {
    this.usingCloud = false;

    const voiceId = await this.resolveDeviceVoice();

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      try {
        DeviceSpeech.speak(text, {
          language: speechLocale(this.language),
          // An explicit identifier beats `language`: iOS otherwise sometimes picks
          // a Mandarin voice to read Cantonese, which is unintelligible.
          ...(voiceId ? { voice: voiceId } : {}),
          rate: this.rate,
          // Let iOS run its own speech session so it ducks other audio properly
          // instead of fighting our recording session.
          useApplicationAudioSession: false,
          onDone: () => finish(),
          onStopped: () => finish(),
          onError: (error) => finish(error ?? new Error('device speech failed')),
        });

        // Some platforms never fire a callback; do not stall the queue forever.
        const guard = setTimeout(
          () => finish(),
          Math.max(4000, text.length * 220)
        );

        this.currentFinish = () => {
          clearTimeout(guard);
          try {
            DeviceSpeech.stop();
          } catch {
            /* ignore */
          }
          finish();
        };
      } catch (error) {
        finish(error ?? new Error('device speech threw'));
      }
    });
  }

  /**
   * Look up the best installed voice for the current language, once.
   *
   * Cached because getAvailableVoicesAsync is not free and the answer only
   * changes when the user installs a voice or switches language.
   */
  async resolveDeviceVoice() {
    if (this.deviceVoiceResolved) return this.deviceVoice;
    this.deviceVoiceResolved = true;
    try {
      this.deviceVoice = (await pickVoiceIdentifier(this.language)) ?? null;
    } catch {
      this.deviceVoice = null;
    }
    return this.deviceVoice;
  }

  /** Which device voice was selected, for diagnostics. */
  getDeviceVoice() {
    return this.deviceVoice;
  }

  /** iOS expo-audio decodes `data:audio/...` into a temp file itself. */
  playDataUri(uri, opts = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.currentFinish = null;
        resolve();
      };

      try {
        if (!this.player) {
          this.player = createAudioPlayer({ uri });
        } else {
          this.player.replace({ uri });
        }

        const sub = this.player.addListener('playbackStatusUpdate', (status) => {
          if (status?.didJustFinish) {
            try {
              sub?.remove?.();
            } catch {
              /* ignore */
            }
            finish();
          }
        });

        this.currentFinish = () => {
          try {
            this.player?.pause();
          } catch {
            /* ignore */
          }
          finish();
        };

        this.player.play();

        // Safety net: if the status listener never fires, do not wedge the queue.
        setTimeout(finish, 20000);
      } catch {
        finish();
      }
    });
  }

  // ------------------------------------------------------------------ control

  cancelCurrent() {
    if (this.currentFinish) {
      const finish = this.currentFinish;
      this.currentFinish = null;
      try {
        finish();
      } catch {
        /* ignore */
      }
    }
    try {
      DeviceSpeech.stop();
    } catch {
      /* ignore */
    }
    this.speaking = false;
  }

  /** Repeat the last announcement. An explicit request, so dedupe is bypassed. */
  repeat() {
    if (!this.last) return false;
    const text = this.last.text;
    this.last = null;
    this.announce(text, { priority: 'interrupt' });
    return true;
  }

  stop() {
    this.cancelCurrent();
    this.pending = [];
    this.speaking = false;
  }
}

/** Singleton: speech is device-global, not per-screen. */
export const speech = new SpeechService();

/**
 * Compose the announcement for a screen.
 *
 * Kept separate from announce() so every screen phrases itself the same way, and
 * so available actions are always included — a blind user cannot see the buttons.
 */
export function screenScript(title, description, actions = [], language = 'yue') {
  const yue = language === 'yue';
  const parts = [title, description].filter(Boolean);
  if (actions.length > 0) {
    parts.push(yue ? `可用動作：${actions.join('、')}。` : `Available actions: ${actions.join(', ')}.`);
  }
  return parts.join(yue ? '。' : '. ');
}
