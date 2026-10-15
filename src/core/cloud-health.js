/**
 * Cloud-voice health state machine.
 *
 * Extracted from the speech service so it can be tested without a device: it has
 * no React Native imports at all.
 *
 * Why this exists: cloud TTS gives good Cantonese, the on-device voice gives
 * robotic Cantonese. Falling back is necessary when offline, but falling back
 * *permanently* because of one dropped packet would silently degrade the app for
 * a blind user who cannot see a status indicator. So:
 *
 *   - one failure is tolerated (transient networks are normal in a city),
 *   - repeated failures open the circuit,
 *   - the circuit closes again automatically after a cooldown,
 *   - an explicit user retry resets it immediately.
 */

export const DEFAULT_FAILURE_LIMIT = 2;
export const DEFAULT_COOLDOWN_MS = 60_000;

export class CloudHealth {
  constructor(options = {}) {
    this.failureLimit = options.failureLimit ?? DEFAULT_FAILURE_LIMIT;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.failures = 0;
    this.retryAt = 0;
    /** True while the circuit is open. Purely for reporting. */
    this.tripped = false;
  }

  /**
   * May we attempt a cloud request right now?
   * @param {number} now injectable clock, so tests do not sleep
   */
  available(now = Date.now()) {
    if (this.failures < this.failureLimit) return true;
    if (now >= this.retryAt) {
      // Cooldown elapsed: allow a probe rather than staying degraded forever.
      return true;
    }
    return false;
  }

  /** Record a success: clears the penalty entirely. */
  recordSuccess() {
    this.failures = 0;
    this.retryAt = 0;
    this.tripped = false;
  }

  /** Record a failure and open the circuit if the limit is reached. */
  recordFailure(now = Date.now()) {
    this.failures += 1;
    if (this.failures >= this.failureLimit) {
      this.retryAt = now + this.cooldownMs;
      this.tripped = true;
    }
    return this.available(now);
  }

  /** Explicit user request: forget everything and try again now. */
  reset() {
    this.failures = 0;
    this.retryAt = 0;
    this.tripped = false;
  }

  describe() {
    if (this.failures === 0) return 'cloud voice healthy';
    if (this.available()) return `cloud voice retrying (${this.failures} recent failures)`;
    return `cloud voice paused for ${Math.ceil((this.retryAt - Date.now()) / 1000)}s`;
  }
}
