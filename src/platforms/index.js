/**
 * The platform registry: the single source of truth for which sites CrediClean
 * runs on and which hosts it may read images from.
 *
 * The manifest's match patterns, the service worker's fetch allowlist and the
 * content script's detection rules are all derived from this one list, so they
 * cannot drift apart. `scripts/verify-manifest.js` checks that the manifest
 * still agrees with it.
 */

import { hostMatches } from './base.js';
import { chatgptAdapter } from './chatgpt.js';
import { geminiAdapter } from './gemini.js';
import { grokAdapter } from './grok.js';

export { SUPPORT } from './base.js';

/** Every supported platform. Order matters only for host matching. */
export const ADAPTERS = [chatgptAdapter, geminiAdapter, grokAdapter];

/**
 * Which adapter, if any, handles this hostname.
 *
 * @param {string} hostname
 * @returns {object|null}
 */
export function adapterForHost(hostname) {
  return ADAPTERS.find((adapter) => hostMatches(hostname, adapter.hosts)) || null;
}

/** The adapter for the page this code is running on. */
export function currentAdapter() {
  return adapterForHost(typeof location !== 'undefined' ? location.hostname : '');
}

/** Every host the extension may fetch an original image from. */
export function allImageHosts() {
  const hosts = new Set();
  for (const adapter of ADAPTERS) {
    for (const host of adapter.imageHosts) hosts.add(host);
  }
  return [...hosts].sort();
}

/** Every host a content script runs on. */
export function allPageHosts() {
  const hosts = new Set();
  for (const adapter of ADAPTERS) {
    for (const host of adapter.hosts) hosts.add(host);
  }
  return [...hosts].sort();
}

/** The internal support matrix, for documentation and tests. Never shown to users. */
export function supportMatrix() {
  const matrix = {};
  for (const adapter of ADAPTERS) matrix[adapter.id] = { ...adapter.support };
  return matrix;
}
