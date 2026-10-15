/**
 * Press-and-hold voice capture.
 *
 * The interaction is deliberately a hold rather than a tap: a blind user cannot
 * see a recording indicator, so the button staying down IS the indicator. The
 * matching haptics fire on press and release so the state is felt, not seen.
 *
 * Recording is `.m4a` (AAC), which is what expo-audio's HIGH_QUALITY preset
 * produces on iOS.
 */

import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { useCallback, useRef, useState } from 'react';

import * as haptics from '@/core/haptics';

export function useVoiceCapture(options = {}) {
  const { onError } = options;

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(null);
  const busy = useRef(false);

  const ensurePermission = useCallback(async () => {
    try {
      const result = await requestRecordingPermissionsAsync();
      const granted = result?.granted ?? result?.status === 'granted';
      setPermissionGranted(granted);
      return granted;
    } catch (error) {
      setPermissionGranted(false);
      onError?.(error?.message ?? 'microphone permission failed');
      return false;
    }
  }, [onError]);

  const start = useCallback(async () => {
    if (busy.current || isRecording) return false;
    busy.current = true;

    try {
      const granted = await ensurePermission();
      if (!granted) {
        haptics.error();
        onError?.('Microphone permission is needed to hear where you want to go.');
        return false;
      }

      // `allowsRecording` must be true or iOS silently produces an empty file.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecording(true);
      await haptics.recordingStart();
      return true;
    } catch (error) {
      haptics.error();
      onError?.(error?.message ?? 'Could not start recording.');
      return false;
    } finally {
      busy.current = false;
    }
  }, [ensurePermission, isRecording, onError, recorder]);

  /** @returns {Promise<{ uri: string|null, durationMs: number }>} */
  const stop = useCallback(async () => {
    if (!isRecording) return { uri: null, durationMs: 0 };

    const startedAt = Date.now();
    try {
      await recorder.stop();
      setIsRecording(false);
      await haptics.recordingStop();

      // Hand the audio session back so playback is not ducked.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });

      return { uri: recorder.uri ?? null, durationMs: Date.now() - startedAt };
    } catch (error) {
      setIsRecording(false);
      onError?.(error?.message ?? 'Could not finish recording.');
      return { uri: null, durationMs: 0 };
    }
  }, [isRecording, onError, recorder]);

  return { start, stop, isRecording, permissionGranted, ensurePermission };
}
