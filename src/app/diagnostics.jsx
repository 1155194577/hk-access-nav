import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { runDiagnostics, summarise } from '@/core/diagnostics';
import * as haptics from '@/core/haptics';
import { speech } from '@/core/speech';
import { useScreenAnnouncement } from '@/hooks/useScreenAnnouncement';
import { Colors, Radius, Spacing, Typography } from '@/ui/theme';

export default function DiagnosticsScreen() {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState('');

  useScreenAnnouncement(
    '連線診斷。',
    '測試每一個網絡服務，睇下邊個唔通。',
    ['Tap Run diagnostics to test every service']
  );

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setResults([]);
    haptics.tick();
    speech.announce('開始診斷，請等一等。', { priority: 'interrupt' });

    try {
      const found = await runDiagnostics({ onProgress: setCurrent });
      setResults(found);

      const failures = found.filter((r) => !r.ok).length;
      if (failures === 0) haptics.success();
      else haptics.error();

      // Speak the verdict, then the details: the summary alone is what matters
      // when the user only wants to know whether the app can work.
      speech.announce(summarise(found), { priority: 'interrupt' });
    } catch (error) {
      haptics.error();
      speech.announce(`診斷失敗：${error?.message ?? '未知錯誤'}`, { priority: 'interrupt' });
    } finally {
      setRunning(false);
      setCurrent('');
    }
  }, [running]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          Tests each service the app depends on and reports what each one said. Press Run,
          then read or listen to the result.
        </Text>

        <Pressable
          onPress={run}
          disabled={running}
          accessibilityRole="button"
          accessibilityLabel={running ? 'Running diagnostics' : 'Run diagnostics'}
          accessibilityHint="Tests the API key, speech, voice, assistant, routing and vision."
          accessibilityState={{ disabled: running, busy: running }}
          style={({ pressed }) => [styles.runButton, pressed && styles.pressed, running && styles.disabled]}>
          <Text style={styles.runText}>{running ? 'RUNNING…' : 'RUN DIAGNOSTICS'}</Text>
        </Pressable>

        {running ? (
          <View style={styles.progressRow}>
            <ActivityIndicator color={Colors.primary} />
            <Text style={styles.progressText}>{current || 'Starting…'}</Text>
          </View>
        ) : null}

        {results.map((result) => (
          <View
            key={result.name}
            style={[
              styles.card,
              result.warn ? styles.cardWarn : result.ok ? styles.cardOk : styles.cardFail,
            ]}
            accessibilityLabel={`${result.name}: ${
              result.warn ? 'warning' : result.ok ? 'passed' : 'failed'
            }. ${result.ok ? result.detail : result.hint ?? result.detail}`}>
            <View style={styles.cardHead}>
              <Text
                style={[
                  styles.badge,
                  result.warn ? styles.badgeWarn : result.ok ? styles.badgeOk : styles.badgeFail,
                ]}>
                {result.warn ? 'WARN' : result.ok ? 'PASS' : 'FAIL'}
              </Text>
              <Text style={styles.cardTitle}>{result.name}</Text>
              <Text style={styles.cardMs}>{result.ms} ms</Text>
            </View>

            <Text style={styles.cardDetail}>{result.detail}</Text>

            {result.hint ? <Text style={styles.cardHint}>{result.hint}</Text> : null}
          </View>
        ))}

        {!running && results.length > 0 ? (
          <Text style={styles.footer}>
            {results.filter((r) => r.ok && !r.warn).length} of {results.length} services
            responded correctly
            {results.some((r) => r.warn) ? ' · warnings need attention' : ''}.
          </Text>
        ) : null}
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
    padding: Spacing.three,
    gap: Spacing.three,
    paddingBottom: Spacing.six,
  },
  intro: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    lineHeight: 20,
  },
  runButton: {
    minHeight: 72,
    borderRadius: Radius.large,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runText: {
    color: '#FFFFFF',
    fontSize: Typography.button,
    fontWeight: '800',
    letterSpacing: 1,
  },
  pressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.6,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  progressText: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
  },
  card: {
    borderRadius: Radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
    gap: Spacing.two,
    backgroundColor: Colors.surface,
  },
  cardOk: {
    borderColor: Colors.success,
  },
  cardWarn: {
    borderColor: Colors.warning,
  },
  cardFail: {
    borderColor: Colors.danger,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  badge: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.small,
    overflow: 'hidden',
  },
  badgeOk: {
    color: '#0B1220',
    backgroundColor: Colors.success,
  },
  badgeWarn: {
    color: '#0B1220',
    backgroundColor: Colors.warning,
  },
  badgeFail: {
    color: '#FFFFFF',
    backgroundColor: Colors.danger,
  },
  cardTitle: {
    flex: 1,
    color: Colors.text,
    fontSize: Typography.caption,
    fontWeight: '700',
  },
  cardMs: {
    color: Colors.textSecondary,
    fontSize: 11,
  },
  cardDetail: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    lineHeight: 19,
  },
  cardHint: {
    color: Colors.warning,
    fontSize: Typography.caption,
    lineHeight: 19,
    fontWeight: '600',
  },
  footer: {
    color: Colors.textSecondary,
    fontSize: Typography.caption,
    textAlign: 'center',
  },
});
