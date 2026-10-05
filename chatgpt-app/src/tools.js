/**
 * What CrediClean actually does, for a ChatGPT app.
 *
 * THE ENGINE IS NOT REIMPLEMENTED HERE. The three imports below are the exact
 * files the Chrome extension runs in the browser, unchanged and unforked. They
 * are pure byte code with no DOM and no browser APIs, which is why they run on
 * a server as they are. If credential handling ever needs fixing, it gets
 * fixed once, in one place, and both products get the fix.
 *
 * Everything in this file is the thin layer around that: read the file ChatGPT
 * passed, call the engine, shape the answer for a chat.
 */

import {
  inspectImage,
  diagnoseImage,
  STATUS,
} from '../../src/processing/metadata-inspector.js';
import { removeCredentials, OUTCOME } from '../../src/processing/credential-processor.js';
import { buildFilename, sourceFilename } from '../../src/processing/download-manager.js';

import { ImageError, fetchImageBytes, holdProcessedFile, readFileParam } from './files.js';

const MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * The facts the panel shows. Deliberately the same three the extension shows:
 * format, size, file. No manifest internals, no C2PA jargon.
 */
function factsFrom(report, filename) {
  return {
    format: report.formatLabel,
    dimensions: report.dimensions
      ? `${report.dimensions.width} × ${report.dimensions.height}`
      : 'Unknown',
    filename: filename || 'Unknown',
  };
}

/**
 * One sentence saying what was found, in the same plain words the extension
 * uses. Never claims more than was established.
 */
function headlineFor(status) {
  switch (status) {
    case STATUS.CREDENTIALS_DETECTED:
      return 'Content Credentials found';
    case STATUS.NO_CREDENTIALS_DETECTED:
      return 'No supported credentials found';
    case STATUS.UNSUPPORTED_FORMAT:
      return 'This image format is not supported';
    default:
      return "Couldn't read this image";
  }
}

/**
 * Get the bytes behind whatever ChatGPT put in the file argument.
 *
 * @param {unknown} fileParam
 * @returns {Promise<{bytes: Uint8Array, fileName: string|null}>}
 */
async function loadImage(fileParam) {
  const file = readFileParam(fileParam);
  const bytes = await fetchImageBytes(file.downloadUrl);
  return { bytes, fileName: file.fileName };
}

/**
 * Look at an image and say what provenance data it carries.
 *
 * Reads only. Nothing is changed, nothing is stored, and the original is never
 * touched.
 */
export async function inspectImageTool(fileParam) {
  const { bytes, fileName } = await loadImage(fileParam);
  const report = inspectImage(bytes);
  const filename = fileName || sourceFilename({ url: '', format: report.format, altText: '' });

  const result = {
    status: report.status,
    headline: headlineFor(report.status),
    canRemove: report.status === STATUS.CREDENTIALS_DETECTED,
    facts: factsFrom(report, filename),
    byteLength: report.byteLength,
  };

  /*
   * "No supported credentials found" has three very different causes that look
   * identical from outside: the file really has none, we were handed a
   * re-encoded copy that lost them, or our parser missed them. The extension
   * puts this in the browser console. Here it goes in the server log, because
   * there is no console to put it in and it is the one thing worth having when
   * someone reports that nothing was found.
   */
  if (report.status === STATUS.NO_CREDENTIALS_DETECTED) {
    try {
      const diagnosis = diagnoseImage(bytes);
      console.log('[CrediClean] Nothing found. Why:', {
        interpretation: diagnosis.interpretation,
        format: diagnosis.format,
        bytes: diagnosis.byteLength,
        container: diagnosis.containerBlocks,
        markers: diagnosis.rawMarkers,
      });
    } catch (error) {
      console.warn('[CrediClean] Diagnosis failed.', error);
    }
  }

  return result;
}

/**
 * Remove the supported credentials and hand back a clean copy.
 *
 * The result is verified before it is offered: same format, no credentials
 * left, same dimensions, and the pixel data byte-identical to the original.
 * If any of those fail, nothing is offered at all.
 */
export async function removeCredentialsTool(fileParam, options = {}) {
  const { bytes, fileName } = await loadImage(fileParam);
  const report = inspectImage(bytes);
  const sourceName = fileName || sourceFilename({ url: '', format: report.format, altText: '' });

  const result = removeCredentials(bytes, {
    removeXmpProvenanceReference: options.removeXmpProvenanceReference !== false,
  });

  if (!result.ok) {
    return {
      status: result.outcome,
      headline:
        result.outcome === OUTCOME.NOTHING_TO_REMOVE
          ? 'No supported credentials found'
          : headlineFor(report.status),
      removed: false,
      canRemove: false,
      facts: factsFrom(report, sourceName),
      /*
       * A failed verification is the one case where we must be explicit that
       * nothing was saved, because the user asked for a change and is about to
       * be given no file.
       */
      message:
        result.outcome === OUTCOME.VERIFICATION_FAILED
          ? 'The result failed our checks, so nothing was saved. The original is untouched.'
          : result.outcome === OUTCOME.NOTHING_TO_REMOVE
            ? 'There is nothing to remove from this image.'
            : result.message || 'This image could not be processed.',
    };
  }

  const filename = buildFilename({ url: sourceName, format: report.format, altText: '' });
  const contentType = MIME_BY_FORMAT[report.format] || 'application/octet-stream';
  const stored = holdProcessedFile(result.output, { filename, contentType });

  return {
    status: 'removed',
    headline: 'Credentials removed',
    removed: true,
    canRemove: false,
    facts: factsFrom(result.report, sourceName),
    download: {
      url: stored.url,
      filename,
      mimeType: contentType,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    },
    bytesRemoved: result.bytesRemoved,
    removedItems: result.removed.map((item) => item.label),
    /*
     * Repeated here, deliberately, every single time. It is the honest limit of
     * what this tool does, and the one claim it must never let a user believe
     * it has made for them.
     */
    note:
      'The picture itself is unchanged, pixel for pixel. Invisible watermarks inside ' +
      'the picture, such as SynthID, are not affected and are not removed.',
  };
}

/** Turn any failure into something a person can read. */
export function describeError(error) {
  if (error instanceof ImageError) {
    if (error.code === 'file-param-not-resolved') {
      return (
        'ChatGPT passed a file path instead of the file itself, so the image could not be ' +
        'read. This is a known limit of the platform rather than a problem with the image.'
      );
    }
    return error.message;
  }
  console.warn('[CrediClean] Unexpected failure.', error);
  return 'Something went wrong handling that image. Please try again.';
}
