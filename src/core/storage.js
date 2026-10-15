/**
 * Device-local settings and the user's home coordinate.
 *
 * Privacy decision, inherited from this project's design notes: the home
 * coordinate lives ONLY on the device. It is never sent to a server except as the
 * origin of an explicit routing request the user asked for, and it is never
 * logged. There are no accounts and no server-side history, so this file is the
 * whole of the app's persistence.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  home: 'hkan.home.v1',
  settings: 'hkan.settings.v1',
};

export const DEFAULT_SETTINGS = {
  /** 'yue' Cantonese, 'zh' Mandarin, 'en' English. */
  language: 'yue',
  /**
   * 'device' uses the iOS built-in voice (offline, and clearer than the cloud
   * model on iOS). 'cloud' uses SiliconFlow CosyVoice2.
   */
  engine: 'device',
  /** Only relevant when engine is 'cloud'; kept on as a device-voice fallback. */
  cloudTts: true,
  haptics: true,
  /** Simple spoken descriptions by default; verbose doubles the talking. */
  verbose: false,
  /** Cloud voice id, used only by the cloud engine. */
  voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
  /**
   * Live hazard scanning with the billed vision model.
   *
   * OFF by default, and that default is the safe one in both directions. The free
   * source (`/api/vlm`) is a verified stub that answers the same sentence for any
   * frame, so it can never be allowed to warn; turning this on sends one photo
   * every few seconds to Qwen3-VL and bills per frame. Either way the user chooses.
   */
  cloudVision: false,
};

export async function loadHome() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.home);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveHome(coordinate) {
  try {
    await AsyncStorage.setItem(KEYS.home, JSON.stringify(coordinate));
    return true;
  } catch {
    return false;
  }
}

export async function loadSettings() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.settings);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  try {
    await AsyncStorage.setItem(KEYS.settings, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Used by the settings screen to prove what is stored, and to erase it. */
export async function inventory() {
  try {
    const [home, settings] = await Promise.all([
      AsyncStorage.getItem(KEYS.home),
      AsyncStorage.getItem(KEYS.settings),
    ]);
    return {
      home: home ? JSON.parse(home) : null,
      settings: settings ? JSON.parse(settings) : null,
    };
  } catch {
    return { home: null, settings: null };
  }
}

export async function eraseAll() {
  try {
    await AsyncStorage.multiRemove(Object.values(KEYS));
    return true;
  } catch {
    return false;
  }
}
