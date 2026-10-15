import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HAZARD } from '@/core/config';
import { prepareFrameForVision } from '@/core/frame';
import * as haptics from '@/core/haptics';
import { hazardSentence } from '@/core/hazards';
import { speech } from '@/core/speech';
import { DEMO_FRAME, loadDemoFrame } from '@/data/demo-frame';
import { useScreenAnnouncement } from '@/hooks/useScreenAnnouncement';
import { describe } from '@/providers/vision';
import { Colors, Radius, Spacing, Typography } from '@/ui/theme';

const MODES = [
  { id: 'describe', label: 'Describe' },
  { id: 'identify', label: 'Name it' },
  { id: 'read-text', label: 'Read text' },
];

export default function WhatIsThisScreen() {
  const [mode, setMode] = useState('describe');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  /** The bundled frame, used when there is no camera. */
  const [frame, setFrame] = useState(null);
  const [frameError, setFrameError] = useState(null);

  const cameraRef = useRef(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [captureError, setCaptureError] = useState(null);
  /**
   * Whether the preview has actually settled.
   *
   * The first frame after the camera mounts is soft — auto-exposure and focus have
   * not converged — and a soft frame is exactly what makes the model answer "I
   * cannot tell". The button waits for the camera to say it is ready.
   */
  const [previewReady, setPreviewReady] = useState(false);

  const cameraReady = Boolean(permission?.granted);
  const canCapture = cameraReady ? previewReady : Boolean(frame);

  useScreenAnnouncement(
    '呢個係咩？',
    cameraReady
      ? '對準你想知嘅嘢，然後按大按鈕，應用程式會影一張相，再講出佢見到咩。'
      : '未有相機權限。可以開啟相機，或者用示範圖片試。',
    cameraReady
      ? ['Tap the big button to photograph what is in front of you and hear what it is']
      : ['Turn on the camera', 'Tap the big button to use the demonstration picture']
  );

  // Decode the bundled frame once, up front: it is the fallback, and the button
  // must never be dead just because the camera is unavailable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadDemoFrame();
        if (!cancelled) setFrame(loaded);
      } catch (error) {
        if (!cancelled) setFrameError(error?.message ?? 'could not load the demo image');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Grab the picture to describe.
   *
   * Camera first: one shutter press, `base64: true` so nothing has to be read back
   * off disk, and the shutter sound suppressed because the phone is already
   * telling the user what it is doing. A capture failure (no camera on the
   * simulator, a busy device) falls back to the bundled frame rather than leaving
   * the user pressing a button that does nothing.
   */
  const captureFrame = useCallback(async () => {
    if (cameraReady && cameraRef.current) {
      try {
        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: HAZARD.jpegQuality,
          shutterSound: false,
        });

        // The raw capture is passed through as a fallback inside the helper; it
        // resizes, normalises orientation and strips EXIF (which carries GPS).
        const prepared = await prepareFrameForVision(photo);
        if (prepared?.base64) {
          setCaptureError(null);
          return { base64: prepared.base64, mime: prepared.mime, usedCamera: true };
        }
        setCaptureError('the camera returned no image');
      } catch (error) {
        setCaptureError(error?.message ?? 'the camera could not take a picture');
      }
    }

    if (!frame) return null;
    return { base64: frame.base64, mime: 'image/png', usedCamera: false };
  }, [cameraReady, frame]);

  const scan = useCallback(async () => {
    if (busy) return;

    setBusy(true);
    haptics.tick();
    speech.announce('睇緊…', { priority: 'normal' });

    try {
      const shot = await captureFrame();

      if (!shot) {
        haptics.error();
        speech.announce(
          frameError ? `載入唔到示範圖片：${frameError}` : '示範圖片仲未準備好。',
          { priority: 'interrupt' }
        );
        return;
      }

      // `sources: ['siliconflow']` — the real vision model (Qwen3-VL). The
      // deployed /api/vlm answers with one fixed sentence for every image
      // (verified), so it is deliberately not in this list: describing a
      // revolving door that is not there is worse than saying nothing.
      // `escalate` re-asks the 32B model when the 8B one shrugs — worth the wait
      // on a single deliberate press, unlike the per-frame hazard scanner.
      const described = await describe(shot.base64, {
        language: 'yue',
        mode,
        mime: shot.mime,
        sources: ['siliconflow'],
        escalate: true,
      });

      setResult({ ...described, usedCamera: shot.usedCamera });

      if (described.hazards?.length > 0) {
        // A hazard always wins: it is the thing that prevents a fall.
        haptics.hazard();
        speech.announce(
          hazardSentence(described.hazards, described.distanceMeters, 'yue'),
          { priority: 'interrupt' }
        );
      } else if (described.description) {
        // "Not certain" is the model declining to guess, which is the correct
        // behaviour and useless on its own: say what to do about it.
        const advice = described.uncertain ? ' 唔係好肯定。試下影近啲，或者去光啲嘅地方再影一次。' : '';
        speech.announce(`${described.description}${advice}`, { priority: 'interrupt' });
      } else {
        haptics.error();
        speech.announce('睇唔到描述，請再試一次。', { priority: 'interrupt' });
      }
    } catch (error) {
      haptics.error();
      speech.announce(`睇唔到：${error?.message ?? '未知錯誤'}`, { priority: 'interrupt' });
    } finally {
      setBusy(false);
    }
  }, [busy, captureFrame, frameError, mode]);

  const enableCamera = useCallback(async () => {
    haptics.tick();
    const next = await requestPermission();
    if (next?.granted) {
      speech.announce('相機已開啟。對準前面，然後按大按鈕。', { priority: 'interrupt' });
    } else {
      haptics.error();
      speech.announce('未開啟相機權限，會用示範圖片。', { priority: 'interrupt' });
    }
  }, [requestPermission]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.frameBox}>
          {cameraReady ? (
            <CameraView
              ref={cameraRef}
              style={styles.frame}
              facing="back"
              onCameraReady={() => setPreviewReady(true)}
            />
          ) : (
            <Image
              source={DEMO_FRAME}
              style={styles.frame}
              resizeMode="cover"
              accessibilityLabel="The demonstration picture that will be sent for description"
            />
          )}
          <View style={styles.demoTag}>
            <Text style={styles.demoTagText}>
              {cameraReady ? 'LIVE CAMERA' : 'DEMO IMAGE — no camera'}
            </Text>
          </View>
        </View>

        {!cameraReady ? (
          <Pressable
            onPress={enableCamera}
            accessibilityRole="button"
            accessibilityLabel="Turn on the camera"
            accessibilityHint="Asks iOS for camera permission so the next picture is what is actually in front of you."
            style={({ pressed }) => [styles.permissionRow, pressed && styles.pressed]}>
            <Text style={styles.permissionText}>
              Turn on the camera to photograph what is in front of you
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.modeRow}>
          {MODES.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => {
                haptics.tick();
                setMode(item.id);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === item.id }}
              accessibilityLabel={item.label}
              style={[styles.modePill, mode === item.id && styles.modePillActive]}>
              <Text style={[styles.modeText, mode === item.id && styles.modeTextActive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {frameError && !cameraReady ? (
          <Text style={styles.error}>Image problem: {frameError}</Text>
        ) : null}

        {captureError && cameraReady ? (
          <Text style={styles.error}>Camera problem: {captureError} — using the demo picture.</Text>
        ) : null}

        {result ? (
          <View
            style={[
              styles.resultBox,
              result.hazards?.length > 0 && styles.resultBoxHazard,
            ]}>
            <Text style={styles.resultLabel}>
              {result.hazards?.length > 0 ? 'HAZARD DETECTED' : 'WHAT THE API SAID'}
            </Text>
            <Text style={styles.resultText}>{result.description || '—'}</Text>

            {result.hazards?.length > 0 ? (
              <Text style={styles.resultHazard}>
                {result.hazards.map((h) => h.label).join(' · ')}
              </Text>
            ) : null}

            {result.uncertain ? (
              <Text style={styles.resultUncertain}>
                The model was not certain — it will not guess. Try again closer, or
                somewhere with more light.
              </Text>
            ) : null}

            <Text style={styles.resultMeta}>
              {result.usedCamera ? 'photo' : 'demo picture'} · source: {result.source}
              {result.model ? ` · ${result.model}` : ''}
              {result.latencyMs != null ? ` · ${result.latencyMs} ms` : ''}
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={scan}
          disabled={busy || !canCapture}
          accessibilityRole="button"
          accessibilityLabel={
            busy
              ? 'Asking the API'
              : canCapture
                ? 'Describe what I am looking at'
                : cameraReady
                  ? 'Waiting for the camera'
                  : 'Waiting for the demo picture'
          }
          accessibilityHint="Takes a picture and reads the description aloud."
          accessibilityState={{ disabled: busy || !canCapture, busy }}
          style={({ pressed }) => [
            styles.scanButton,
            pressed && styles.pressed,
            (busy || !canCapture) && styles.disabled,
          ]}>
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.scanText}>ASKING THE API…</Text>
            </View>
          ) : (
            <Text style={styles.scanText}>
              {canCapture ? 'WHAT IS THIS?' : cameraReady ? 'PREPARING CAMERA…' : 'LOADING IMAGE…'}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.three, gap: Spacing.three, paddingBottom: Spacing.six },
  frameBox: {
    borderRadius: Radius.medium,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  frame: { width: '100%', aspectRatio: 4 / 3 },
  demoTag: {
    position: 'absolute',
    left: Spacing.two,
    top: Spacing.two,
    backgroundColor: 'rgba(11,18,32,0.86)',
    borderRadius: Radius.small,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  demoTagText: { color: Colors.warning, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  permissionRow: {
    minHeight: 56,
    borderRadius: Radius.medium,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  permissionText: { color: Colors.text, fontSize: Typography.caption, fontWeight: '700' },
  modeRow: { flexDirection: 'row', gap: Spacing.two },
  modePill: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  modePillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  modeText: { color: Colors.textSecondary, fontSize: Typography.caption, fontWeight: '700' },
  modeTextActive: { color: '#FFFFFF' },
  error: { color: Colors.danger, fontSize: Typography.caption },
  resultBox: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  resultBoxHazard: { borderColor: Colors.danger, backgroundColor: Colors.dangerSurface },
  resultLabel: {
    color: Colors.primary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  resultText: { color: Colors.text, fontSize: Typography.body, fontWeight: '600' },
  resultHazard: { color: Colors.danger, fontSize: Typography.caption, fontWeight: '800' },
  resultUncertain: { color: Colors.warning, fontSize: Typography.caption, fontStyle: 'italic' },
  resultMeta: { color: Colors.textSecondary, fontSize: 11 },
  scanButton: {
    minHeight: 88,
    borderRadius: Radius.large,
    backgroundColor: '#C2478B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  scanText: { color: '#FFFFFF', fontSize: Typography.button, fontWeight: '800', letterSpacing: 1 },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.6 },
});
