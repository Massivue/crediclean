/**
 * The message contract between the content script and the service worker.
 *
 * The content script cannot always fetch an image itself: a CDN URL is
 * cross-origin and the page's CORS rules apply to content-script fetches under
 * Manifest V3. The service worker holds the host permissions, so it can.
 */

export const MESSAGE = {
  FETCH_IMAGE: 'crediclean/fetch-image',
  PING: 'crediclean/ping',
};

/** Error codes, so the UI can choose its own wording rather than echo an exception. */
export const ERROR_CODE = {
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  TOO_LARGE: 'too-large',
  NOT_AN_IMAGE: 'not-an-image',
  EMPTY: 'empty',
  BAD_URL: 'bad-url',
  NO_BACKGROUND: 'no-background',
  UNKNOWN: 'unknown',
};

/** Convert bytes to a base64 string in chunks, to avoid blowing the call stack. */
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
