import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { Colors } from '@/ui/theme';

SplashScreen.preventAutoHideAsync();

/**
 * Expo Router's DarkTheme, retinted to this app's palette so the native headers
 * match the screens and we do not get a bright flash of default blue.
 */
const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: Colors.background,
    card: Colors.surface,
    text: Colors.text,
    border: Colors.border,
    primary: Colors.primary,
    notification: Colors.danger,
  },
};

export default function RootLayout() {
  useEffect(() => {
    // Hide as soon as the first route has mounted; the app announces itself by
    // speaking, so there is nothing to wait for visually.
    void SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <ThemeProvider value={navigationTheme}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: Colors.surface },
          headerTintColor: Colors.text,
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: Colors.background },
        }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="visit" options={{ title: 'Random visit' }} />
        <Stack.Screen name="navigation" options={{ title: 'Navigating', headerBackTitle: 'Back' }} />
        <Stack.Screen name="what-is-this" options={{ title: 'What is this?' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="diagnostics" options={{ title: 'Connection check' }} />
      </Stack>
      <StatusBar style="light" />
    </ThemeProvider>
  );
}
