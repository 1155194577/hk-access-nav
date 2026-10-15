import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useScreenReader } from '@/hooks/useScreenReader';
import { Colors, Radius, Spacing, Typography } from './theme';

/**
 * Speak control.
 *
 * Two interaction models, because VoiceOver cannot perform one of them:
 *
 *  NO SCREEN READER — press and hold. The button physically staying down IS the
 *  recording indicator for a user who cannot see a recording light; haptics fire
 *  on both edges so the state is felt. Releasing sends.
 *
 *  VOICEOVER ON — double-tap to start, double-tap again to stop. VoiceOver
 *  consumes the touch gesture to move focus, so a press-and-hold never reaches
 *  the button. Double-tap is the activation gesture VoiceOver does provide, and
 *  it maps cleanly onto start/stop.
 *
 * The label and hint change with the mode so what VoiceOver reads describes the
 * gesture the user can actually make.
 */
export function HoldToSpeakButton({
  isRecording,
  onPressIn,
  onPressOut,
  onToggle,
  disabled = false,
}) {
  const screenReaderActive = useScreenReader();

  if (screenReaderActive) {
    const label = isRecording ? 'Stop listening' : 'Speak where you want to go';
    return (
      <View style={styles.wrapper}>
        <Pressable
          onPress={onToggle}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={
            isRecording
              ? 'Double tap to stop listening and search for the place.'
              : 'Double tap to start listening. Then say where you want to go, and double tap again to stop.'
          }
          accessibilityState={{ disabled, busy: isRecording, selected: isRecording }}
          style={({ pressed }) => [
            styles.button,
            isRecording && styles.buttonRecording,
            pressed && !isRecording && styles.buttonPressed,
            disabled && styles.disabled,
          ]}>
          <Text style={styles.mic} accessibilityElementsHidden importantForAccessibility="no">
            {isRecording ? '●' : '🎤'}
          </Text>
          <Text style={styles.label}>{isRecording ? 'STOP LISTENING' : 'SPEAK'}</Text>
        </Pressable>

        <Text style={styles.hint}>
          {isRecording
            ? 'Listening… double tap to stop'
            : 'Double tap to start, say your place, double tap to stop'}
        </Text>
      </View>
    );
  }

  const label = isRecording ? 'RELEASE TO SEND' : 'PRESS & HOLD TO SPEAK';

  return (
    <View style={styles.wrapper}>
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={
          isRecording
            ? 'Lift your finger to finish speaking.'
            : 'Hold your finger down, say where you want to go, then lift your finger.'
        }
        accessibilityState={{ disabled, busy: isRecording }}
        style={({ pressed }) => [
          styles.button,
          isRecording && styles.buttonRecording,
          pressed && !isRecording && styles.buttonPressed,
          disabled && styles.disabled,
        ]}>
        <Text style={styles.mic} accessibilityElementsHidden importantForAccessibility="no">
          {isRecording ? '●' : '🎤'}
        </Text>
        <Text style={styles.label}>{label}</Text>
      </Pressable>

      {isRecording ? (
        <Text style={styles.listening}>Listening…</Text>
      ) : (
        <Text style={styles.hint}>Hold down, speak, then let go</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    gap: Spacing.two,
    width: '100%',
  },
  button: {
    width: '100%',
    minHeight: 110,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  buttonPressed: {
    backgroundColor: Colors.primaryPressed,
    transform: [{ scale: 0.98 }],
  },
  buttonRecording: {
    backgroundColor: Colors.danger,
    transform: [{ scale: 1.02 }],
  },
  mic: {
    fontSize: 36,
    color: '#FFFFFF',
  },
  label: {
    color: '#FFFFFF',
    fontSize: Typography.button,
    fontWeight: '800',
    letterSpacing: 1,
    textAlign: 'center',
  },
  hint: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    textAlign: 'center',
  },
  listening: {
    color: Colors.danger,
    fontSize: Typography.caption,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.45,
  },
});
