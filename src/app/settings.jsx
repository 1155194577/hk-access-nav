import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import * as haptics from '@/core/haptics';
import { speech } from '@/core/speech';
import { DEFAULT_SETTINGS, eraseAll, inventory, loadSettings, saveSettings, saveHome } from '@/core/storage';
import { describeVoice, findVoices } from '@/core/voices';
import { useLocation } from '@/hooks/useLocation';
import { useScreenAnnouncement } from '@/hooks/useScreenAnnouncement';
import { Colors, Radius, Spacing, TouchTarget, Typography } from '@/ui/theme';

const ACTIONS = [
  'Switch language',
  'Choose the voice',
  'Toggle haptics',
  'Set home to your current location',
  'Erase everything',
];

/** Sample sentence per language, so the test exercises the real script. */
const SETTINGS_SAMPLE = {
  yue: '前面有樓梯，向右行十步。',
  zh: '前面有楼梯，向右走十步。',
  en: 'There are stairs ahead. Turn right and walk ten steps.',
};

const LABELS = { yue: 'Cantonese', zh: 'Mandarin', en: 'English' };

/**
 * Routing mode changes are worth speaking: they decide what happens when the
 * user walks out of the surveyed area, which is not something to discover mid
 * journey from silence.
 */
const ROUTING_ANNOUNCE = {
  auto: '已改為自動選擇路線。',
  server: '已改為伺服器路線，需要數據連接。',
  offline: '已改為離線地圖。只覆蓋中環、尖沙咀、長沙灣。',
};

export default function SettingsScreen() {
  const router = useRouter();
  const { location, isUsable, error: locationError } = useLocation({ enabled: true });
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [home, setHome] = useState(null);
  const [saved, setSaved] = useState(false);
  /** Result of the last voice test, so the answer is visible as well as spoken. */
  const [voiceNote, setVoiceNote] = useState(null);
  /** Which voices the device actually has installed, for the current language. */
  const [deviceVoiceNote, setDeviceVoiceNote] = useState(null);

  useScreenAnnouncement('設定。', '語言、語音同屋企位置。', ACTIONS);

  useEffect(() => {
    void (async () => {
      const [loaded, stored] = await Promise.all([loadSettings(), inventory()]);
      setSettings(loaded);
      setHome(stored.home);
      // Apply the stored language/engine to the live service on open, otherwise
      // the app would speak with defaults until the user touched a setting.
      speech.updateConfig({
        language: loaded.language,
        engine: loaded.engine,
        cloudEnabled: loaded.cloudTts,
        voice: loaded.voice,
      });
    })();
  }, []);

  /**
   * Ask the device which voices it actually has for the current language.
   *
   * This is the answer to "is there an AVSpeechSynthesizer voice for Cantonese
   * and Mandarin?" — it depends on the device and what the user has downloaded,
   * so the app reports it rather than assuming.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { chosen, candidates } = await findVoices(settings.language);
        if (cancelled) return;
        if (chosen) {
          setDeviceVoiceNote(
            `Device voice: ${describeVoice(chosen)}${
              candidates.length > 1 ? ` (+${candidates.length - 1} more)` : ''
            }`
          );
        } else {
          setDeviceVoiceNote(
            `No ${LABELS[settings.language] ?? settings.language} voice installed — iOS will use the language tag. Add one in iOS Settings › Accessibility › Spoken Content › Voices.`
          );
        }
      } catch (error) {
        if (!cancelled) setDeviceVoiceNote(`Could not list voices: ${error?.message ?? 'unknown'}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.language]);

  /** Apply changes to both persistence and the live speech service. */
  const update = useCallback(
    async (patch) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      await saveSettings(next);

      speech.updateConfig({
        language: next.language,
        engine: next.engine,
        cloudEnabled: next.cloudTts,
        voice: next.voice,
      });
      haptics.setHapticsEnabled(next.haptics);

      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    },
    [settings]
  );

  const setRoutingMode = useCallback(
    (mode) => {
      haptics.tick();
      void update({ routingMode: mode });
      speech.announce(ROUTING_ANNOUNCE[mode], { priority: 'interrupt' });
    },
    [update]
  );

  async function adoptCurrentLocation() {
    if (!isUsable || !location) {
      haptics.error();
      speech.announce(
        '仲未有好嘅定位信號，請行去空曠啲嘅地方再試。',
        { priority: 'interrupt' }
      );
      return;
    }

    const coordinate = {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
      savedAt: Date.now(),
    };

    const ok = await saveHome(coordinate);
    if (ok) {
      setHome(coordinate);
      haptics.success();
      speech.announce('已經將你而家嘅位置設定為屋企。', { priority: 'interrupt' });
    } else {
      haptics.error();
      speech.announce('儲存唔到，請再試一次。', { priority: 'interrupt' });
    }
  }

  async function wipe() {
    await eraseAll();
    setHome(null);
    setSettings(DEFAULT_SETTINGS);
    haptics.success();
    speech.announce('已經清除所有儲存嘅資料。', { priority: 'interrupt' });
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="LANGUAGE">
          <Row
            label="Cantonese"
            hint="粵語 — spoken and heard in Cantonese"
            selected={settings.language === 'yue'}
            onPress={() => update({ language: 'yue' })}
          />
          <Row
            label="Mandarin"
            hint="普通話 — spoken and heard in Mandarin"
            selected={settings.language === 'zh'}
            onPress={() => update({ language: 'zh' })}
          />
          <Row
            label="English"
            hint="Spoken and heard in English"
            selected={settings.language === 'en'}
            onPress={() => update({ language: 'en' })}
          />
        </Section>

        <Section title="VOICE">
          <Row
            label="On-device voice"
            hint="Offline, instant, no data. Uses the iOS built-in voice."
            selected={settings.engine === 'device'}
            onPress={() => update({ engine: 'device' })}
          />
          <Row
            label="Cloud voice (CosyVoice2)"
            hint="Online, needs data. Used automatically if the device voice fails."
            selected={settings.engine === 'cloud'}
            onPress={() => update({ engine: 'cloud' })}
          />

          <View style={styles.infoRow}>
            <Text style={styles.infoText}>
              {deviceVoiceNote ?? 'Checking which voices this device has…'}
            </Text>
          </View>

          <Row
            label="Test the voice"
            hint={
              voiceNote ?? 'Speaks a sample sentence, then says which voice it used'
            }
            onPress={() => {
              haptics.tick();
              setVoiceNote('Speaking…');
              speech.announce(
                SETTINGS_SAMPLE[settings.language] ?? SETTINGS_SAMPLE.yue,
                {
                  priority: 'interrupt',
                  // Report the voice that ACTUALLY produced the audio, rather
                  // than guessing from the toggle state.
                  onVoice: (voice) =>
                    setVoiceNote(
                      voice === 'cloud'
                        ? 'Last test: cloud voice (CosyVoice2) — online'
                        : `Last test: on-device voice${speech.getStatus().deviceVoice ? ` — ${speech.getStatus().deviceVoice}` : ' — iOS default'}`
                    ),
                }
              );
            }}
          />
          <Row
            label="Test cloud voice"
            hint="Checks the online voice directly and reports the result"
            onPress={async () => {
              haptics.tick();
              setVoiceNote('Checking the cloud voice…');
              const result = await speech.retryCloud();
              setVoiceNote(
                result.ok
                  ? 'Cloud voice OK — available as a fallback'
                  : `Cloud voice FAILED: ${result.error}`
              );
              haptics[result.ok ? 'success' : 'error']();
            }}
          />
          <View style={styles.infoRow}>
            <Text style={styles.infoWarning}>
              iOS note: the on-device voice is silent while the hardware mute switch
              is on. There is no API to override that. Turn the mute switch off, or
              choose the cloud voice, which plays through the media channel.
            </Text>
          </View>
        </Section>

        <Section title="FEEDBACK">
          <ToggleRow
            label="Haptics"
            hint="Vibration for turns, hazards and arrivals"
            value={settings.haptics}
            onChange={(value) => {
              haptics.setHapticsEnabled(value);
              void update({ haptics: value });
            }}
          />
          <Row
            label="Test hazard pattern"
            hint="The strong pattern used for obstacles"
            onPress={() => haptics.hazard()}
          />
        </Section>

        <Section title="HOME">
          <Row
            label="Set home to my current location"
            hint={
              isUsable
                ? `Accuracy about ${Math.round(location?.accuracy ?? 0)} m`
                : locationError ?? 'Waiting for a good GPS fix'
            }
            onPress={adoptCurrentLocation}
          />
          <View style={styles.infoRow}>
            <Text style={styles.infoText}>
              {home
                ? `Saved: ${home.latitude.toFixed(5)}, ${home.longitude.toFixed(5)}`
                : 'No home location saved yet.'}
            </Text>
          </View>
        </Section>

        <Section title="ROUTING">
          <Row
            label="Automatic"
            hint="Offline map when your trip is inside it, otherwise the server."
            selected={settings.routingMode === 'auto'}
            onPress={() => setRoutingMode('auto')}
          />
          <Row
            label="Server routing"
            hint="City-wide coverage. Needs a data connection, and sends your origin and destination to the server."
            selected={settings.routingMode === 'server'}
            onPress={() => setRoutingMode('server')}
          />
          <Row
            label="Offline map"
            hint="No data, no round trip. Covers Central, Tsim Sha Tsui and Cheung Sha Wan only."
            selected={settings.routingMode === 'offline'}
            onPress={() => setRoutingMode('offline')}
          />
          <View style={styles.infoRow}>
            <Text style={styles.infoText}>
              {settings.routingMode === 'offline'
                ? 'Outside those three districts the app will say it cannot route, rather than quietly going online.'
                : settings.routingMode === 'server'
                  ? 'Every route request goes to the server, including trips inside the offline map.'
                  : 'The offline map is preferred wherever it covers the trip.'}
            </Text>
          </View>
        </Section>

        <Section title="VISION">
          <ToggleRow
            label="Cloud vision (Qwen3-VL)"
            hint="Look for obstacles while navigating, using the paid vision model. Off: no obstacle scanning, because the free one is a placeholder."
            value={settings.cloudVision}
            onChange={(value) => {
              haptics.tick();
              void update({ cloudVision: value });
            }}
          />
          <View style={styles.infoRow}>
            <Text style={styles.infoWarning}>
              Sends one photo every few seconds while the navigation screen is open,
              and is billed per photo. Leave it off on a metered connection.
            </Text>
          </View>
        </Section>

        <Section title="CONNECTION">
          <Row
            label="Run connection check"
            hint="Tests the API key, speech, voice, assistant, routing and vision"
            onPress={() => {
              haptics.tick();
              router.push('/diagnostics');
            }}
          />
        </Section>

        <Section title="PRIVACY">
          <Text style={styles.privacyText}>
            Your home location and settings are stored only on this device. There is no
            account, and nothing is uploaded except the specific requests you make — a
            recording when you speak, a frame when you ask what something is, and your
            route request.
          </Text>
          <Row
            label="Erase everything"
            hint="Deletes your home location and settings"
            destructive
            onPress={wipe}
          />
        </Section>

        {saved ? <Text style={styles.saved}>Saved</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, hint, onPress, selected = false, destructive = false }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.rowBody}>
        <Text style={[styles.rowLabel, destructive && styles.destructive]}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

function ToggleRow({ label, hint, value, onChange }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ true: Colors.primary, false: Colors.surfaceRaised }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: Spacing.three,
    gap: Spacing.five,
    paddingBottom: Spacing.six,
  },
  section: {
    gap: Spacing.two,
  },
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  sectionBody: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.medium,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: TouchTarget.min,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  rowBody: {
    flex: 1,
    gap: Spacing.one,
  },
  rowLabel: {
    color: Colors.text,
    fontSize: Typography.body,
    fontWeight: '600',
  },
  rowHint: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
  },
  check: {
    color: Colors.primary,
    fontSize: 24,
    fontWeight: '800',
  },
  destructive: {
    color: Colors.danger,
  },
  pressed: {
    backgroundColor: Colors.surfaceRaised,
  },
  infoRow: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  infoText: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
  },
  infoWarning: {
    color: Colors.warning,
    fontSize: Typography.caption,
    lineHeight: 19,
  },
  privacyText: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    lineHeight: 20,
    padding: Spacing.three,
  },
  saved: {
    color: Colors.success,
    fontSize: Typography.caption,
    fontWeight: '800',
    textAlign: 'center',
  },
});
