/**
 * Cross-screen trip state.
 *
 * A tiny external store rather than context, for one reason: the AR navigation
 * screen and the voice screen both write to the active trip, and they are
 * separate routes. A module-level store with subscribers keeps that simple and
 * avoids a provider hierarchy that Expo Router would rebuild on navigation.
 */

import { useSyncExternalStore } from 'react';

const listeners = new Set();

let state = {
  /** The route plan currently being walked, or null. */
  trip: null,
  /** Where the user asked to go, as resolved from speech. */
  destination: null,
  /** Last thing the assistant said, for display on the voice screen. */
  lastUtterance: null,
  lastReply: null,
};

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTrip() {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function clearTrip() {
  setState({ trip: null, destination: null });
}

export function startTrip(trip, destination) {
  setState({ trip, destination });
}
