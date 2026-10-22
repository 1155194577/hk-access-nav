import { Pressable, StyleSheet, Text, View } from 'react-native';

import { VARIANTS } from './button-variants';
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
          <View style={styles.iconChip}>
            <Text
              style={styles.icon}
              accessibilityElementsHidden
              importantForAccessibility="no"
              aria-hidden>
              {icon}
            </Text>
          </View>
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

const styles = StyleSheet.create({
  button: {
    minHeight: TouchTarget.primary,
    borderRadius: Radius.large,
    borderWidth: 2,
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
  /**
   * Emoji render in their own colours and wash out on a bright fill, so they get
   * a near-black chip. It also gives every action a single high-contrast anchor
   * at the same position, which helps a low-vision user find the row.
   */
  iconChip: {
    width: 52,
    height: 52,
    borderRadius: Radius.medium,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 30,
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
