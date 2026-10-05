/**
 * Getting an image in, and getting the processed one back out.
 *
 * This is the half of the app that does not exist in the Chrome extension,
 * and it is where the risk lives. The extension never fetched a URL someone
 * else chose and never held anyone's picture. This server does both, so both
 * are bounded here rather than spread through the tool handlers.
 */

import { randomBytes } from 'node:crypto';

import {
  ALLOWED_DOWNLOAD_HOSTS,
  DOWNLOAD_TIMEOUT_MS,
  MAX_HELD_FILES,
  MAX_IMAGE_BYTES,
  PROCESSED_FILE_TTL_MS,
  PUBLIC_BASE_URL,
} from './config.js';

/** Thrown for anything the user should be told about in plain words. */
export class ImageError extends Error {
  constructor(message, { code = 'image-error', detail = null } = {}) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Read the file argument ChatGPT passed in.
 *
 * When a tool declares `_meta["openai/fileParams"]`, ChatGPT is documented to
 * replace the argument with an object carrying a `download_url`. When it does
 * NOT, or when the mechanism does not cover whatever the user pointed at, the
 * argument arrives as a bare string such as "/mnt/data/image.png", which is a
 * path inside ChatGPT's own sandbox and is useless to us.
 *
 * That second case is the single most likely way this whole app fails, so it
 * gets its own error rather than a type crash, and the error says exactly what
 * arrived. See docs/CHATGPT_NATIVE_PLUGIN_FEASIBILITY.md section 2.
 *
 * @param {unknown} value whatever arrived in the file parameter
 * @returns {{downloadUrl: string, fileId: string|null, mimeType: string|null, fileName: string|null}}
 */
export function readFileParam(value) {
  if (typeof value === 'string') {
    throw new ImageError(
      'ChatGPT passed a file path rather than a downloadable file, so the image could not be read.',
      { code: 'file-param-not-resolved', detail: value },
    );
  }
  if (!value || typeof value !== 'object') {
    throw new ImageError('No image was provided.', { code: 'no-file', detail: String(value) });
  }

  // ChatGPT uses snake_case here. Accept camelCase too: it costs nothing and
  // means a hand-written test or a future rename does not silently break.
  const downloadUrl = value.download_url || value.downloadUrl || null;
  if (!downloadUrl) {
    throw new ImageError(
      'The image reference had no download address, so the file could not be fetched.',
      { code: 'no-download-url', detail: Object.keys(value).join(', ') },
    );
  }

  return {
    downloadUrl: String(downloadUrl),
    fileId: value.file_id || value.fileId || null,
    mimeType: value.mime_type || value.mimeType || null,
    fileName: value.file_name || value.fileName || null,
  };
}

/**
 * Is this an address this server is willing to fetch?
 *
 * Exported so it is directly testable, because an SSRF guard that is never
 * tested is a guard nobody should trust.
 *
 * @param {string} rawUrl
 * @param {string[]} [allowedHosts]
 * @returns {{ok: boolean, reason?: string, host?: string}}
 */
export function isAllowedDownloadUrl(rawUrl, allowedHosts = ALLOWED_DOWNLOAD_HOSTS) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not-a-url' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not-https', host: url.hostname };
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!allowed) return { ok: false, reason: 'host-not-allowed', host };
  return { ok: true, host };
}

/**
 * Download the image, refusing anything we should not fetch or cannot hold.
 *
 * @param {string} downloadUrl
 * @returns {Promise<Uint8Array>}
 */
export async function fetchImageBytes(downloadUrl) {
  const verdict = isAllowedDownloadUrl(downloadUrl);
  if (!verdict.ok) {
    if (verdict.reason === 'host-not-allowed') {
      // The one line needed to fix a wrong guess about OpenAI's file hosts.
      console.warn(
        `[CrediClean] Refused to download from "${verdict.host}". If that is a ` +
          'legitimate ChatGPT file host, add it to CREDICLEAN_ALLOWED_HOSTS.',
      );
    }
    throw new ImageError('That image could not be fetched from where it is hosted.', {
      code: verdict.reason,
      detail: verdict.host || downloadUrl,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(downloadUrl, { signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    throw new ImageError('The image could not be downloaded.', {
      code: 'fetch-failed',
      detail: String(error && error.message ? error.message : error),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ImageError('The image could not be downloaded.', {
      code: 'bad-status',
      detail: `HTTP ${response.status}`,
    });
  }

  // Check the declared length before reading, so an oversized file is refused
  // rather than buffered and then refused.
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > MAX_IMAGE_BYTES) {
    throw new ImageError('That image is too large to process.', {
      code: 'too-large',
      detail: `${declared} bytes`,
    });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  // And again afterwards: content-length can be absent or wrong.
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageError('That image is too large to process.', {
      code: 'too-large',
      detail: `${bytes.length} bytes`,
    });
  }
  if (bytes.length === 0) {
    throw new ImageError('That image came back empty.', { code: 'empty' });
  }
  return bytes;
}

/* ------------------------------------------------------------------------ */
/* Holding a processed file just long enough for the user to save it         */
/* ------------------------------------------------------------------------ */

/**
 * Processed images, waiting to be downloaded.
 *
 * In memory on purpose. Nothing is written to disk, so a processed image
 * cannot outlive the process, cannot be backed up by accident and cannot be
 * found later by someone with filesystem access. The cost is that a restart
 * loses pending downloads, which is the right trade for somebody's picture.
 */
const held = new Map(); // token -> {bytes, filename, contentType, expiresAt}

function sweep(now = Date.now()) {
  for (const [token, entry] of held) {
    if (entry.expiresAt <= now) held.delete(token);
  }
}

/**
 * Keep a processed file and return the address to fetch it from.
 *
 * @param {Uint8Array} bytes
 * @param {{filename: string, contentType: string}} meta
 * @returns {{token: string, url: string, expiresAt: number}}
 */
export function holdProcessedFile(bytes, { filename, contentType }) {
  sweep();

  // A hard cap as well as a time limit: a burst of traffic must not be able to
  // fill memory faster than the clock empties it. Oldest goes first.
  while (held.size >= MAX_HELD_FILES) {
    const oldest = [...held.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (!oldest) break;
    held.delete(oldest[0]);
  }

  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + PROCESSED_FILE_TTL_MS;
  held.set(token, { bytes, filename, contentType, expiresAt });
  return { token, url: `${PUBLIC_BASE_URL}/files/${token}`, expiresAt };
}

/**
 * Fetch a held file, if it is still there.
 *
 * @param {string} token
 * @returns {{bytes: Uint8Array, filename: string, contentType: string}|null}
 */
export function takeProcessedFile(token) {
  sweep();
  const entry = held.get(token);
  if (!entry) return null;
  return { bytes: entry.bytes, filename: entry.filename, contentType: entry.contentType };
}

/** For tests and for a clean shutdown. */
export function clearHeldFiles() {
  held.clear();
}

export function heldFileCount() {
  sweep();
  return held.size;
}
