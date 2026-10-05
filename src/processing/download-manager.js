/**
 * Saves a processed image to the user's computer.
 *
 * This runs in the content script and uses a blob URL plus a temporary anchor
 * element. That is deliberate: it means the extension does NOT need Chrome's
 * "downloads" permission, and nothing is ever saved without the user clicking
 * a button first.
 */

import { extensionFor, mimeTypeFor } from '../formats/detect.js';

/** Characters that are unsafe or awkward in a filename, on any platform. */
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * Work out a sensible filename for the processed image.
 *
 * ChatGPT serves images from signed URLs that often carry no usable name, so we
 * try the URL path, then the image's alt text, then a dated fallback.
 *
 * @param {object} args
 * @param {string} args.url the image address
 * @param {string} args.format detected format, from FORMAT.*
 * @param {string} [args.altText] the <img> alt attribute
 * @param {string} [args.suffix] appended before the extension
 * @param {Date} [args.now] injectable for testing
 * @returns {string}
 */
export function buildFilename({ url, format, altText, suffix = '-processed', now = new Date() }) {
  const extension = extensionFor(format);
  let base = '';

  // 1. The last path segment of the URL, if it looks like a filename.
  try {
    const path = new URL(url, 'https://example.invalid').pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
    const withoutExtension = last.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    if (withoutExtension && /[A-Za-z0-9]/.test(withoutExtension)) base = withoutExtension;
  } catch {
    /* fall through to the next strategy */
  }

  // 2. Alt text, which for a generated image is often a short description.
  if (!base && altText) {
    base = altText.trim().slice(0, 60).replace(/\s+/g, '-');
  }

  // 3. A dated fallback, so the file is still identifiable.
  if (!base) {
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    base = `crediclean-image-${stamp}`;
  }

  base = base.replace(UNSAFE_FILENAME, '').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80);
  if (!base) base = 'crediclean-image';

  return `${base}${suffix}.${extension}`;
}

/**
 * The image's own filename, with no processing suffix. Shown in the panel so
 * the user can tell which image they are looking at.
 *
 * @param {{url: string, format: string, altText?: string}} args
 * @returns {string}
 */
export function sourceFilename({ url, format, altText }) {
  return buildFilename({ url, format, altText, suffix: '' });
}

/**
 * Trigger a download of these bytes.
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {string} format one of FORMAT.*
 * @returns {{ok: boolean, error?: string, byteLength?: number}}
 */
export function downloadBytes(bytes, filename, format) {
  if (!bytes || bytes.length === 0) {
    return { ok: false, error: 'There was nothing to save.' };
  }

  let objectUrl = null;
  try {
    const blob = new Blob([bytes], { type: mimeTypeFor(format) });
    // Verify the blob actually holds what we expect before offering it.
    if (blob.size !== bytes.length) {
      return { ok: false, error: 'The file could not be prepared correctly.' };
    }

    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    // `anchor.click()` dispatches a real, bubbling click event. Left alone it
    // travels up to <body> and <document>, where anything listening for an
    // outside click (our own result panel, and quite possibly something in the
    // host page) would treat it as the user clicking away. Stop it at the
    // anchor: the browser still performs the download.
    anchor.addEventListener('click', (event) => event.stopPropagation());

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    return { ok: true, byteLength: bytes.length };
  } catch {
    return { ok: false, error: 'The file could not be saved.' };
  } finally {
    // Give the browser a moment to start the download before releasing the URL.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  }
}
