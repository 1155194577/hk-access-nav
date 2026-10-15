/**
 * Periodic frame scanning for hazards.
 *
 * expo-camera 57 has NO frame processor — this was verified by grepping the
 * installed package: there is no `onFrame`, no `frameProcessor`, and no
 * VisionCamera interop. So "live" analysis here means polling `takePictureAsync`
 * on a timer, which is the only mechanism the library exposes.
 *
 * Consequences that shape this hook:
 *
 *   - Each scan is a real shutter capture (a few hundred ms), so the interval is
 *     measured from the END of the previous scan, never on a fixed timer that
 *     would queue captures up behind a slow network.
 *   - The shutter sound is suppressed, because a phone clicking every second in a
 *     user's hand is both conspicuous and confusing.
 *   - Quality is lowered: this is hazard detection, not photography, and smaller
 *     frames mean a faster round trip on a mobile connection.
 *   - A warning is only surfaced once per hazard label per window. Repeating
 *     "obstacle ahead" every second makes the app unusable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { HAZARD } from '@/core/config';
import { prepareFrameForVision } from '@/core/frame';
import { hazardSentence, isUrgent } from '@/core/hazards';
import * as haptics from '@/core/haptics';
import { speech } from '@/core/speech';
import { loadSettings } from '@/core/storage';
import { scanSources } from '@/core/vision-policy';
import { announceAdaptive, isScreenReaderEnabled } from '@/hooks/useScreenReader';
import { describe } from '@/providers/vision';

export function useHazardScanner({ cameraRef, enabled, language = 'yue', intervalMs = 2500 }) {
  const [hazard, setHazard] = useState(null);
  const [lastDescription, setLastDescription] = useState('');
  const [scanning, setScanning] = useState(false);
  /**
   * Whether this walk may use the billed vision model. Read once when the screen
   * mounts: navigation is a short-lived screen, and re-reading storage on every
   * scan would put a disk read in front of a hazard warning.
   */
  const [cloudVision, setCloudVision] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = await loadSettings();
      if (!cancelled) setCloudVision(Boolean(settings.cloudVision));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const running = useRef(false);
  const stopped = useRef(false);
  const seenAt = useRef(new Map());

  const scanOnce = useCallback(async () => {
    const camera = cameraRef?.current;
    if (!camera || running.current) return null;

    running.current = true;
    setScanning(true);

    try {
      const photo = await camera.takePictureAsync({
        base64: true,
        quality: HAZARD.jpegQuality,
        // A shutter click every scan interval would be maddening, and on some
        // devices it also steals focus from the audio session.
        shutterSound: false,
      });

      if (!photo) return null;

      // Downscale, normalise orientation and drop EXIF before any frame leaves the
      // phone — at one frame every few seconds, full-resolution photos were also
      // carrying the user's GPS to the vision vendor, repeatedly.
      const prepared = await prepareFrameForVision(photo, { maxPx: HAZARD.scanFrameMaxPx });
      if (!prepared?.base64) return null;

      // Which source may look at this frame is the user's call (Settings › Cloud
      // vision): the billed model sees, the free one is a stub that answers the
      // same sentence for every picture. See core/vision-policy.js.
      const result = await describe(prepared.base64, {
        language,
        mode: 'describe',
        mime: prepared.mime,
        sources: scanSources(cloudVision),
      });

      // An untrusted source must not put text on screen either: the stub answers
      // "a glass revolving door is 3 steps ahead" no matter what the camera saw.
      setLastDescription(result.trusted === false ? '' : result.description ?? '');

      if (!result.hazards || result.hazards.length === 0) {
        setHazard(null);
        return result;
      }

      const urgent = isUrgent(result.hazards[0], result.distanceMeters);
      const label = result.hazards[0].code;
      const now = Date.now();
      const previously = seenAt.current.get(label) ?? 0;

      // Suppress repeats, but let a genuinely urgent hazard through more often.
      const window = urgent ? HAZARD.repeatSuppressMs : HAZARD.repeatSuppressMs * 3;
      if (now - previously < window) return result;

      seenAt.current.set(label, now);

      const corrective = result.confidence === 'high' ? '請慢低，小心行。' : null;
      const sentence = hazardSentence(
        result.hazards,
        result.distanceMeters,
        language,
        corrective
      );

      const next = {
        ...result,
        sentence,
        urgent,
      };
      setHazard(next);

      if (urgent) {
        // Hazards pre-empt everything, and the strong haptic pattern is the
        // fall-prevention signal. Both fire even if speech is disabled.
        //
        // Unlike screen descriptions, a hazard is NOT suppressed under VoiceOver:
        // a duplicated warning is far better than a missed obstacle. It is routed
        // to whichever narrator is in charge so the user hears it exactly once,
        // from the right voice.
        haptics.hazard();
        const screenReader = await isScreenReaderEnabled();
        announceAdaptive(speech, sentence, {
          screenReader,
          priority: 'interrupt',
        });
      }

      return result;
    } catch {
      // A failed scan is not worth interrupting the user for; navigation
      // instructions are still flowing.
      return null;
    } finally {
      running.current = false;
      setScanning(false);
    }
  }, [cameraRef, language, cloudVision]);

  useEffect(() => {
    if (!enabled) return undefined;

    stopped.current = false;

    // Paid scanning gets a floor on its gap: a call every 2.5 s all the way down a
    // street is a bill the user did not agree to. The loop measures from the END
    // of the previous scan, so model latency usually dominates anyway.
    const gap = cloudVision ? Math.max(intervalMs, HAZARD.cloudScanIntervalMs) : intervalMs;

    // Self-scheduling loop: the next scan starts `gap` AFTER the previous one
    // finished, so a slow network can never build a backlog of captures.
    async function loop() {
      while (!stopped.current) {
        await scanOnce();
        if (stopped.current) break;
        await new Promise((resolve) => setTimeout(resolve, gap));
      }
    }

    void loop();

    return () => {
      stopped.current = true;
    };
  }, [enabled, intervalMs, scanOnce, cloudVision]);

  const clearHazard = useCallback(() => setHazard(null), []);

  return { hazard, lastDescription, scanning, scanOnce, clearHazard };
}
