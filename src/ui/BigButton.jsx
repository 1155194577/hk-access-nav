import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing, TouchTarget, Typography } from './theme';

/**
 * A large, obvious action.
 *
 * Deliberately oversized: the user may be walking, holding a cane in the other
 * hand, and unable to aim precisely. Every button also carries an
 * `accessibilityLabel` and a `hint`, because VoiceOver users navigate by those
 * rather than by the visible text.
 */
export function BigButton({
  title,
  subtitle,
  icon,
  onPress,
  onLongPress,
  variant = 'primary',
  disabled = false,
  accessibilityHint,
  style,
}) {
  const palette = VARIANTS[variant] ?? VARIANTS.primary;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: pressed ? palette.pressed : palette.background,
          borderColor: palette.border,
        },
        disabled && styles.disabled,
        style,
      ]}>
      <View style={styles.row}>
        {icon ? (
          // Decorative only. Without hiding it, VoiceOver reads the emoji name
          // ("compass") before the label, which is noise on every single control.
          <Text
            style={styles.icon}
            accessibilityElementsHidden
            importantForAccessibility="no"
            aria-hidden>
            {icon}
          </Text>
        ) : null}
        <View style={styles.labels}>
          <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: palette.subtitle }]}>{subtitle}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const VARIANTS = {
  primary: {
    background: Colors.primary,
    pressed: Colors.primaryPressed,
    border: Colors.primary,
    text: '#FFFFFF',
    subtitle: 'rgba(255,255,255,0.85)',
  },
  secondary: {
    background: Colors.surfaceRaised,
    pressed: Colors.surface,
    border: Colors.border,
    text: Colors.text,
    subtitle: Colors.textSecondary,
  },
  danger: {
    background: Colors.danger,
    pressed: '#D93A3C',
    border: Colors.danger,
    text: '#FFFFFF',
    subtitle: 'rgba(255,255,255,0.85)',
  },
  accent: {
    background: '#C2478B',
    pressed: '#A03372',
    border: '#C2478B',
    text: '#FFFFFF',
    subtitle: 'rgba(255,255,255,0.85)',
  },
};

const styles = StyleSheet.create({
  button: {
    minHeight: TouchTarget.primary,
    borderRadius: Radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    justifyContent: 'center',
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  icon: {
    fontSize: 34,
  },
  labels: {
    flex: 1,
    gap: Spacing.one,
  },
  title: {
    fontSize: Typography.button,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: Typography.caption,
    fontWeight: '500',
  },
  disabled: {
    opacity: 0.45,
  },
});
