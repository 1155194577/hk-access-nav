import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import * as haptics from '@/core/haptics';
import { speech } from '@/core/speech';
import { loadHome } from '@/core/storage';
import { useScreenAnnouncement } from '@/hooks/useScreenAnnouncement';
import { BigButton } from '@/ui/BigButton';
import { Colors, Radius, Spacing, Typography } from '@/ui/theme';

const ACTIONS = ['Random visit', 'Go back home', 'What is this', 'Settings'];

export default function MainMenuScreen() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useScreenAnnouncement(
    'Homerouting，你最可靠嘅夥伴。',
    '主目錄。',
    ACTIONS
  );

  /** Walk to the saved home coordinate. */
  async function goHome() {
    if (busy) return;
    setBusy(true);
    haptics.tick();

    const home = await loadHome();
    setBusy(false);

    if (!home) {
      haptics.error();
      speech.announce(
        '仲未設定屋企位置。請去設定，用你而家嘅位置做屋企。',
        { priority: 'interrupt' }
      );
      return;
    }

    router.push({ pathname: '/navigation', params: { mode: 'home' } });
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        // Large text can overflow; a blind user with large-type settings must
        // still be able to reach every button.
        showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Homerouting
          </Text>
          <Text style={styles.subtitle}>Your best companion</Text>
          <Text style={styles.tagline}>Voice-first navigation for Hong Kong</Text>
        </View>

        <View style={styles.actions}>
          <BigButton
            title="Nearby MTR stations"
            subtitle="Finds the closest stations to where you are"
            icon="🧭"
            variant="primary"
            onPress={() => {
              haptics.tick();
              router.push('/visit');
            }}
            accessibilityHint="Lists the nearest MTR stations using your location, and lets you navigate to one."
          />

          <BigButton
            title="Go back home"
            subtitle="Walk to your saved home location"
            icon="🏠"
            variant="primary"
            disabled={busy}
            onPress={goHome}
            accessibilityHint="Starts navigating to the home location you saved in settings."
          />

          <BigButton
            title="What is this?"
            subtitle="Point the camera and hear a description"
            icon="📷"
            variant="accent"
            onPress={() => {
              haptics.tick();
              router.push('/what-is-this');
            }}
            accessibilityHint="Describes what the camera is pointing at and warns about hazards."
          />
        </View>

        <BigButton
          title="Settings"
          subtitle="Language, speech and home location"
          variant="secondary"
          onPress={() => {
            haptics.tick();
            router.push('/settings');
          }}
        />

        <Text style={styles.footer}>
          Tip: press and hold the big blue button anywhere to speak.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.five,
    paddingBottom: Spacing.six,
  },
  header: {
    gap: Spacing.two,
    paddingTop: Spacing.four,
  },
  title: {
    color: Colors.text,
    fontSize: Typography.hero,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  subtitle: {
    color: Colors.primary,
    fontSize: Typography.title,
    fontWeight: '700',
  },
  tagline: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
  },
  actions: {
    gap: Spacing.three,
  },
  footer: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    textAlign: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.medium,
    padding: Spacing.three,
    overflow: 'hidden',
  },
});
