/**
 * Removes supported provenance credentials from an image, losslessly.
 *
 * HOW THIS WORKS, AND WHY IT IS LOSSLESS
 *
 * All three supported formats are containers: a header followed by a list of
 * independently framed blocks. The compressed pixel data lives in its own
 * blocks (PNG IDAT, the JPEG scan after SOS, WebP VP8/VP8L). A C2PA manifest
 * lives in a different block: a PNG `caBX` chunk, one or more JPEG APP11
 * segments, or a WebP `C2PA` chunk.
 *
 * So removal is block surgery, not image editing. We copy every block we keep
 * byte-for-byte and drop the ones we do not. The image is never decoded,
 * re-encoded, redrawn or recompressed, so there is no quality loss and no
 * change in dimensions. `verifyRemoval` below proves that claim on every run by
 * comparing the pixel data of the output against the input byte-for-byte.
 *
 * WHAT THIS DOES NOT DO
 *
 * It removes metadata. It does not and cannot remove information carried in the
 * pixels themselves, such as an invisible watermark. Nothing in this module
 * supports a claim that the output is undetectable or indistinguishable from a
 * human-made image.
 */

import { FORMAT, detectFormat, isSupportedFormat } from '../formats/detect.js';
import * as png from '../formats/png.js';
import * as jpeg from '../formats/jpeg.js';
import * as webp from '../formats/webp.js';
import { inspectImage, STATUS, groupApp11Segments } from './metadata-inspector.js';

export const OUTCOME = {
  REMOVED: 'removed',
  NOTHING_TO_REMOVE: 'nothing-to-remove',
  UNSUPPORTED_FORMAT: 'unsupported-format',
  UNREADABLE: 'unreadable',
  VERIFICATION_FAILED: 'verification-failed',
};

const DEFAULT_OPTIONS = {
  /**
   * Also drop an XMP packet when it contains a provenance reference pointing at
   * the manifest we are removing. Default true: leaving a pointer to a manifest
   * that is no longer there is both misleading and an incomplete removal. The
   * trade-off is that any unrelated XMP fields in the same packet (author,
   * copyright, caption) go with it, which the result itemises.
   */
  removeXmpProvenanceReference: true,
};

/**
 * @param {Uint8Array} bytes the original image file; never modified
 * @param {object} [options]
 * @returns {{outcome: string, ok: boolean, output: Uint8Array|null,
 *   removed: Array<{label: string, location: string, bytes: number}>,
 *   bytesRemoved: number, verification: object|null, message: string,
 *   report: object}}
 */
export function removeCredentials(bytes, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const report = inspectImage(bytes);

  const base = { removed: [], bytesRemoved: 0, output: null, verification: null, report };

  if (report.status === STATUS.UNSUPPORTED_FORMAT) {
    return { ...base, outcome: OUTCOME.UNSUPPORTED_FORMAT, ok: false, message: report.structureError };
  }
  if (report.status === STATUS.UNREADABLE) {
    return { ...base, outcome: OUTCOME.UNREADABLE, ok: false, message: report.structureError };
  }
  if (report.status === STATUS.NO_CREDENTIALS_DETECTED) {
    return {
      ...base,
      outcome: OUTCOME.NOTHING_TO_REMOVE,
      ok: false,
      message: 'No supported credentials were found, so there was nothing to remove.',
    };
  }

  let result;
  try {
    if (report.format === FORMAT.PNG) result = stripPng(bytes, settings);
    else if (report.format === FORMAT.JPEG) result = stripJpeg(bytes, settings);
    else if (report.format === FORMAT.WEBP) result = stripWebp(bytes, settings);
    else {
      return { ...base, outcome: OUTCOME.UNSUPPORTED_FORMAT, ok: false, message: 'Unsupported image format.' };
    }
  } catch (error) {
    return {
      ...base,
      outcome: OUTCOME.UNREADABLE,
      ok: false,
      message: 'This image could not be processed. Its internal structure may be damaged.',
      technicalDetail: error && error.message ? error.message : String(error),
    };
  }

  const verification = verifyRemoval(bytes, result.output, report.format);
  const bytesRemoved = bytes.length - result.output.length;

  if (!verification.ok) {
    // Never hand back a file we could not prove is sound.
    return {
      ...base,
      outcome: OUTCOME.VERIFICATION_FAILED,
      ok: false,
      verification,
      message: 'The processed image failed our own checks, so it was discarded. The original is untouched.',
    };
  }

  return {
    outcome: OUTCOME.REMOVED,
    ok: true,
    output: result.output,
    removed: result.removed,
    bytesRemoved,
    verification,
    report,
    message: `Removed ${result.removed.length} metadata block${result.removed.length === 1 ? '' : 's'}.`,
  };
}

function stripPng(bytes, settings) {
  const parsed = png.parsePngChunks(bytes);
  const kept = [];
  const removed = [];

  for (const chunk of parsed.chunks) {
    if (chunk.type === png.C2PA_CHUNK_TYPE) {
      removed.push({
        label: 'C2PA manifest store',
        location: `PNG ${png.C2PA_CHUNK_TYPE} chunk`,
        bytes: chunk.totalLength,
      });
      continue;
    }
    if (settings.removeXmpProvenanceReference && chunk.type === 'iTXt') {
      const keyword = png.readITXtKeyword(bytes, chunk);
      if (keyword === png.XMP_ITXT_KEYWORD && containsProvenanceReference(bytes, chunk.dataOffset, chunk.dataLength)) {
        removed.push({
          label: 'XMP packet containing a provenance reference',
          location: 'PNG iTXt chunk',
          bytes: chunk.totalLength,
          note: 'Any unrelated XMP fields in this packet were removed with it.',
        });
        continue;
      }
    }
    kept.push(chunk);
  }

  return { output: png.serialisePngChunks(bytes, kept), removed };
}

function stripJpeg(bytes, settings) {
  const parsed = jpeg.parseJpegSegments(bytes);
  const groups = groupApp11Segments(bytes, parsed.segments);

  // Every segment belonging to a C2PA box instance must go, not just the first.
  const doomed = new Set();
  const removed = [];
  for (const group of groups) {
    if (!group.isC2pa) continue;
    for (const segment of group.segments) doomed.add(segment.offset);
    removed.push({
      label: 'C2PA manifest store',
      location:
        group.segments.length === 1
          ? 'JPEG APP11 segment'
          : `${group.segments.length} contiguous JPEG APP11 segments`,
      bytes: group.totalBytes,
    });
  }

  const kept = [];
  for (const segment of parsed.segments) {
    if (doomed.has(segment.offset)) continue;
    if (settings.removeXmpProvenanceReference && jpeg.isXmpSegment(bytes, segment)) {
      if (containsProvenanceReference(bytes, segment.payloadOffset, segment.payloadLength)) {
        removed.push({
          label: 'XMP packet containing a provenance reference',
          location: 'JPEG APP1 (XMP)',
          bytes: segment.totalLength,
          note: 'Any unrelated XMP fields in this packet were removed with it.',
        });
        continue;
      }
    }
    kept.push(segment);
  }

  return { output: jpeg.serialiseJpegSegments(bytes, kept, parsed.scanOffset), removed };
}

function stripWebp(bytes, settings) {
  const parsed = webp.parseWebpChunks(bytes);
  const kept = [];
  const removed = [];

  for (const chunk of parsed.chunks) {
    if (chunk.fourcc === webp.C2PA_CHUNK_FOURCC) {
      removed.push({ label: 'C2PA manifest store', location: 'WebP C2PA chunk', bytes: chunk.totalLength });
      continue;
    }
    if (
      settings.removeXmpProvenanceReference &&
      chunk.fourcc === webp.XMP_CHUNK_FOURCC &&
      containsProvenanceReference(bytes, chunk.dataOffset, chunk.dataLength)
    ) {
      removed.push({
        label: 'XMP packet containing a provenance reference',
        location: 'WebP XMP chunk',
        bytes: chunk.totalLength,
        note: 'Any unrelated XMP fields in this packet were removed with it.',
      });
      continue;
    }
    kept.push(chunk);
  }

  return { output: webp.serialiseWebpChunks(bytes, kept), removed };
}

function containsProvenanceReference(bytes, offset, length) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(offset, offset + Math.min(length, 65536)),
  );
  return text.includes('dcterms:provenance');
}

/**
 * Independently check the processed file before it is offered to the user.
 *
 * This is the whole basis for claiming removal worked, so it re-reads the
 * output from scratch rather than trusting the code that produced it:
 *
 *   1. the output is still a valid file of the same format;
 *   2. a fresh inspection of the output finds no supported credentials;
 *   3. the pixel dimensions are unchanged;
 *   4. the compressed pixel data is byte-for-byte identical to the input,
 *      which is what proves nothing was re-encoded.
 *
 * @returns {{ok: boolean, checks: Array<{name: string, passed: boolean, detail: string}>}}
 */
export function verifyRemoval(original, output, expectedFormat) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });

  const outputFormat = detectFormat(output);
  add(
    'Output is still a valid image container',
    outputFormat === expectedFormat && isSupportedFormat(outputFormat),
    outputFormat === expectedFormat ? `Still ${expectedFormat.toUpperCase()}.` : `Format changed to ${outputFormat}.`,
  );

  const after = inspectImage(output);
  add(
    'No supported credentials remain',
    after.status === STATUS.NO_CREDENTIALS_DETECTED,
    after.status === STATUS.NO_CREDENTIALS_DETECTED
      ? 'A fresh scan of the output found none.'
      : `Output still reports: ${after.status}.`,
  );

  const before = inspectImage(original);
  const sameDimensions =
    !!before.dimensions &&
    !!after.dimensions &&
    before.dimensions.width === after.dimensions.width &&
    before.dimensions.height === after.dimensions.height;
  add(
    'Dimensions unchanged',
    sameDimensions,
    before.dimensions && after.dimensions
      ? `${before.dimensions.width}x${before.dimensions.height} -> ${after.dimensions.width}x${after.dimensions.height}`
      : 'Dimensions could not be read from one of the files.',
  );

  const pixels = comparePixelData(original, output, expectedFormat);
  add('Pixel data is byte-for-byte identical', pixels.identical, pixels.detail);

  return { ok: checks.every((check) => check.passed), checks };
}

/**
 * Compare just the compressed pixel payload of two files. If these bytes match,
 * the images decode to exactly the same pixels, so no recompression happened.
 */
export function comparePixelData(original, output, format) {
  try {
    if (format === FORMAT.PNG) {
      const a = concatChunkData(original, png.parsePngChunks(original).chunks.filter((c) => c.type === 'IDAT'));
      const b = concatChunkData(output, png.parsePngChunks(output).chunks.filter((c) => c.type === 'IDAT'));
      return compareBuffers(a, b, 'IDAT');
    }
    if (format === FORMAT.JPEG) {
      const a = original.subarray(jpeg.parseJpegSegments(original).scanOffset);
      const b = output.subarray(jpeg.parseJpegSegments(output).scanOffset);
      return compareBuffers(a, b, 'scan data');
    }
    if (format === FORMAT.WEBP) {
      const pixelChunks = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANMF']);
      const a = concatChunkData(
        original,
        webp.parseWebpChunks(original).chunks.filter((c) => pixelChunks.has(c.fourcc)),
      );
      const b = concatChunkData(output, webp.parseWebpChunks(output).chunks.filter((c) => pixelChunks.has(c.fourcc)));
      return compareBuffers(a, b, 'bitstream');
    }
    return { identical: false, detail: 'Cannot compare pixel data for this format.' };
  } catch (error) {
    return { identical: false, detail: `Pixel comparison failed: ${error && error.message}` };
  }
}

function concatChunkData(bytes, chunks) {
  let size = 0;
  for (const chunk of chunks) size += chunk.dataLength;
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(bytes.subarray(chunk.dataOffset, chunk.dataOffset + chunk.dataLength), cursor);
    cursor += chunk.dataLength;
  }
  return out;
}

function compareBuffers(a, b, what) {
  if (a.length === 0 || b.length === 0) {
    return { identical: false, detail: `No ${what} found to compare.` };
  }
  if (a.length !== b.length) {
    return { identical: false, detail: `${what} length changed: ${a.length} -> ${b.length} bytes.` };
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return { identical: false, detail: `${what} differs at byte ${i}.` };
  }
  return { identical: true, detail: `${a.length} bytes of ${what} match exactly.` };
}
