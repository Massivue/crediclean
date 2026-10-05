/** Reads and writes the handful of settings this extension has. */

import { DEFAULT_SETTINGS, STORAGE_KEY } from './constants.js';

/** @returns {Promise<typeof DEFAULT_SETTINGS>} */
export async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored?.[STORAGE_KEY] || {}) };
  } catch {
    // Storage can fail if sync is unavailable; fall back to defaults rather
    // than leaving the extension in an undefined state.
    return { ...DEFAULT_SETTINGS };
  }
}

/** @param {Partial<typeof DEFAULT_SETTINGS>} patch */
export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

/** Call `listener` whenever settings change in any context. */
export function onSettingsChanged(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'sync' || area === 'local') && changes[STORAGE_KEY]) {
      listener({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue || {}) });
    }
  });
}
