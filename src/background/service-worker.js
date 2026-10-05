/**
 * Background service worker.
 *
 * This is deliberately thin. Its only job is to fetch image bytes on behalf of
 * the content script, because under Manifest V3 a content-script fetch is
 * subject to the page's CORS rules while the service worker can use the
 * extension's host permissions.
 *
 * It does no image processing, stores nothing, and talks to no server other
 * than the image URL the content script asked for.
 */

import { MESSAGE, ERROR_CODE, bytesToBase64 } from '../shared/messages.js';
import { SIZE_LIMITS, FETCH_TIMEOUT_MS, STORAGE_KEY, DEFAULT_SETTINGS } from '../shared/constants.js';
import { allImageHosts } from '../platforms/index.js';

/**
 * Hosts we are willing to fetch an original image from.
 *
 * Derived from the platform registry rather than written out again here, so
 * the worker, the manifest and the content script cannot drift apart.
 * `npm run verify` fails if the manifest stops agreeing with it.
 */
const ALLOWED_HOST_SUFFIXES = allImageHosts();

function isAllowedUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
  );
}

async function fetchImageBytes(rawUrl) {
  if (!isAllowedUrl(rawUrl)) {
    /*
     * The image-hosting domains for Gemini, Copilot and Grok are not
     * documented publicly, so some of the entries in the registry are
     * inferences. When one of them is wrong this is where it shows up, so log
     * the host that was actually refused: that is the single piece of
     * information needed to correct the adapter.
     */
    let host = '(unparseable)';
    try {
      host = new URL(rawUrl).hostname;
    } catch {
      /* keep the placeholder */
    }
    console.warn(
      `[CrediClean] Refused to fetch from "${host}". If this is where a supported ` +
        'platform serves its generated images, add it to that platform\'s ' +
        'imageHosts in src/platforms/.',
    );
    return { ok: false, code: ERROR_CODE.BAD_URL, error: 'That image address is not one this extension may read.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(rawUrl, {
      credentials: 'include', // ChatGPT's own endpoints are session-authenticated
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        code: ERROR_CODE.NETWORK,
        error: `The image could not be downloaded (server said ${response.status}).`,
      };
    }

    // Refuse early if the server tells us the file is oversized.
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > SIZE_LIMITS.MAX_BYTES) {
      return { ok: false, code: ERROR_CODE.TOO_LARGE, error: 'That image is too large to process.' };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes.length === 0) {
      return { ok: false, code: ERROR_CODE.EMPTY, error: 'The downloaded image was empty.' };
    }
    if (bytes.length > SIZE_LIMITS.MAX_BYTES) {
      return { ok: false, code: ERROR_CODE.TOO_LARGE, error: 'That image is too large to process.' };
    }

    return {
      ok: true,
      base64: bytesToBase64(bytes),
      byteLength: bytes.length,
      contentType: response.headers.get('content-type') || '',
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { ok: false, code: ERROR_CODE.TIMEOUT, error: 'The image took too long to download.' };
    }
    return { ok: false, code: ERROR_CODE.NETWORK, error: 'The image could not be downloaded.' };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === MESSAGE.PING) {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MESSAGE.FETCH_IMAGE) {
    fetchImageBytes(message.url).then(sendResponse);
    return true; // keep the message channel open for the async reply
  }

  return false;
});

/*
 * Seed default settings on first install so the popup never shows a blank state.
 *
 * NOTE: everything this listener needs is imported statically at the top of the
 * file. Dynamic `import()` is forbidden inside a service worker by the HTML
 * specification (https://github.com/w3c/ServiceWorker/issues/1356), and using
 * it here previously raised an uncaught TypeError on every install. The worker
 * is declared as `"type": "module"` in the manifest, so static imports are the
 * correct and supported way to pull anything in.
 */
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  if (!stored || !stored[STORAGE_KEY]) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
  }
});
