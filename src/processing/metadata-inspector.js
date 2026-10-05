/**
 * Reads what provenance and metadata an image actually contains.
 *
 * Scope and honesty boundaries, which the UI copy must not overstate:
 *
 *  - We detect the PRESENCE and STRUCTURE of an embedded C2PA manifest store,
 *    and we read the labels inside it. Those labels are plain strings in the
 *    JUMBF box descriptions, so what we report is read directly out of the file.
 *  - We do NOT cryptographically validate the manifest. We never say a
 *    credential is "valid", "trusted" or "genuine".
 *  - "No supported credentials detected" means only that: this file, in the
 *    places this build knows how to look. It is not proof the image never had
 *    provenance data, and it says nothing about invisible pixel watermarks,
 *    which this extension cannot see or affect.
 */

import { FORMAT, FORMAT_LABELS, detectFormat, isSupportedFormat } from '../formats/detect.js';
import * as png from '../formats/png.js';
import * as jpeg from '../formats/jpeg.js';
import * as webp from '../formats/webp.js';
import { parseJumbfBoxes, looksLikeC2paStore, summariseC2paStore } from '../formats/jumbf.js';

export const STATUS = {
  CREDENTIALS_DETECTED: 'credentials-detected',
  NO_CREDENTIALS_DETECTED: 'no-credentials-detected',
  UNSUPPORTED_FORMAT: 'unsupported-format',
  UNREADABLE: 'unreadable',
};

/** XMP key C2PA uses to point at a manifest. */
const XMP_PROVENANCE_HINT = 'dcterms:provenance';

/**
 * @param {Uint8Array} bytes the complete image file
 * @returns {object} an inspection report
 */
export function inspectImage(bytes) {
  const report = {
    format: FORMAT.UNKNOWN,
    formatLabel: FORMAT_LABELS[FORMAT.UNKNOWN],
    supported: false,
    byteLength: bytes ? bytes.length : 0,
    dimensions: null,
    status: STATUS.UNREADABLE,
    c2pa: { present: false, locations: [], manifestCount: 0, assertionLabels: [], claimGenerators: [] },
    otherMetadata: [],
    warnings: [],
    structureError: null,
  };

  if (!bytes || bytes.length === 0) {
    report.structureError = 'The image file is empty.';
    return report;
  }

  report.format = detectFormat(bytes);
  report.formatLabel = FORMAT_LABELS[report.format] || FORMAT_LABELS[FORMAT.UNKNOWN];
  report.supported = isSupportedFormat(report.format);

  if (!report.supported) {
    report.status = STATUS.UNSUPPORTED_FORMAT;
    report.structureError =
      report.format === FORMAT.UNKNOWN
        ? 'This file is not a recognised image format.'
        : `${report.formatLabel} files are not supported by this version.`;
    return report;
  }

  try {
    if (report.format === FORMAT.PNG) inspectPng(bytes, report);
    else if (report.format === FORMAT.JPEG) inspectJpeg(bytes, report);
    else if (report.format === FORMAT.WEBP) inspectWebp(bytes, report);
  } catch (error) {
    report.status = STATUS.UNREADABLE;
    report.structureError = 'This image could not be read. Its internal structure may be damaged.';
    report.technicalDetail = error && error.message ? error.message : String(error);
    return report;
  }

  if (report.structureError) {
    report.status = STATUS.UNREADABLE;
    return report;
  }

  report.status = report.c2pa.present ? STATUS.CREDENTIALS_DETECTED : STATUS.NO_CREDENTIALS_DETECTED;
  return report;
}

function inspectPng(bytes, report) {
  const parsed = png.parsePngChunks(bytes);
  if (!parsed.ok) {
    report.structureError = parsed.error;
    return;
  }
  if (parsed.truncated) {
    report.warnings.push('This PNG looks truncated. Some metadata may not have been read.');
  }
  report.dimensions = png.readPngDimensions(bytes, parsed.chunks);

  for (const chunk of parsed.chunks) {
    if (chunk.type === png.C2PA_CHUNK_TYPE) {
      describeC2paRegion(bytes, chunk.dataOffset, chunk.dataLength, `PNG ${png.C2PA_CHUNK_TYPE} chunk`, report);
    } else if (chunk.type === 'iTXt' || chunk.type === 'tEXt' || chunk.type === 'zTXt') {
      const keyword = png.readITXtKeyword(bytes, chunk);
      if (keyword === png.XMP_ITXT_KEYWORD) {
        report.otherMetadata.push(makeXmpEntry(bytes, chunk.dataOffset, chunk.dataLength, `PNG ${chunk.type} chunk`));
      }
    } else if (chunk.type === 'eXIf') {
      report.otherMetadata.push({
        kind: 'exif',
        label: 'EXIF metadata',
        location: 'PNG eXIf chunk',
        bytes: chunk.dataLength,
        hasProvenanceReference: false,
      });
    }
  }
}

function inspectJpeg(bytes, report) {
  const parsed = jpeg.parseJpegSegments(bytes);
  if (!parsed.ok) {
    report.structureError = parsed.error;
    return;
  }
  report.dimensions = jpeg.readJpegDimensions(bytes, parsed.segments);

  // Group APP11 segments by box instance: one manifest store may be split
  // across several segments because a JPEG segment cannot exceed 64 KiB.
  const app11Groups = groupApp11Segments(bytes, parsed.segments);
  for (const group of app11Groups) {
    if (!group.isC2pa || !group.box) continue;
    // A manifest store larger than 64 KiB is split across segments, so the box
    // is reassembled before being walked. Walking the raw file here would read
    // the intervening segment headers as box data.
    describeC2paRegion(
      group.box,
      0,
      group.box.length,
      group.segments.length === 1
        ? 'JPEG APP11 segment'
        : `${group.segments.length} contiguous JPEG APP11 segments`,
      report,
      group.totalBytes,
    );
  }

  for (const segment of parsed.segments) {
    if (jpeg.isXmpSegment(bytes, segment)) {
      report.otherMetadata.push(makeXmpEntry(bytes, segment.payloadOffset, segment.payloadLength, 'JPEG APP1 (XMP)'));
    } else if (jpeg.isExifSegment(bytes, segment)) {
      report.otherMetadata.push({
        kind: 'exif',
        label: 'EXIF metadata',
        location: 'JPEG APP1 (EXIF)',
        bytes: segment.payloadLength,
        hasProvenanceReference: false,
      });
    }
  }
}

function inspectWebp(bytes, report) {
  const parsed = webp.parseWebpChunks(bytes);
  if (!parsed.ok) {
    report.structureError = parsed.error;
    return;
  }
  if (parsed.truncated) {
    report.warnings.push('This WebP looks truncated. Some metadata may not have been read.');
  }
  report.dimensions = webp.readWebpDimensions(bytes, parsed.chunks);

  for (const chunk of parsed.chunks) {
    if (chunk.fourcc === webp.C2PA_CHUNK_FOURCC) {
      describeC2paRegion(bytes, chunk.dataOffset, chunk.dataLength, 'WebP C2PA chunk', report);
    } else if (chunk.fourcc === webp.XMP_CHUNK_FOURCC) {
      report.otherMetadata.push(makeXmpEntry(bytes, chunk.dataOffset, chunk.dataLength, 'WebP XMP chunk'));
    } else if (chunk.fourcc === webp.EXIF_CHUNK_FOURCC) {
      report.otherMetadata.push({
        kind: 'exif',
        label: 'EXIF metadata',
        location: 'WebP EXIF chunk',
        bytes: chunk.dataLength,
        hasProvenanceReference: false,
      });
    }
  }
}

/**
 * Group contiguous APP11 segments that belong to the same JUMBF box instance,
 * and decide whether that box is a C2PA manifest store.
 */
export function groupApp11Segments(bytes, segments) {
  const groups = new Map();
  for (const segment of segments) {
    const header = jpeg.readApp11Header(bytes, segment);
    if (!header || header.tbox !== 'jumb') continue;

    if (!groups.has(header.boxInstance)) {
      groups.set(header.boxInstance, {
        boxInstance: header.boxInstance,
        segments: [],
        totalBytes: 0,
        isC2pa: false,
      });
    }
    const group = groups.get(header.boxInstance);
    group.segments.push(segment);
    group.totalBytes += segment.totalLength;
  }

  for (const group of groups.values()) {
    group.segments.sort((a, b) => a.offset - b.offset);
    const reassembled = jpeg.reassembleApp11Box(bytes, group.segments);
    if (!reassembled) continue;
    group.box = reassembled.bytes;
    const { boxes } = parseJumbfBoxes(group.box, 0, group.box.length);
    group.isC2pa = looksLikeC2paStore(boxes);
  }
  return [...groups.values()];
}

function describeC2paRegion(bytes, offset, length, location, report, reportedBytes) {
  const { boxes, truncated } = parseJumbfBoxes(bytes, offset, offset + length);
  const isStore = looksLikeC2paStore(boxes);

  if (!isStore) {
    report.warnings.push(
      `A provenance container was found in the ${location} but could not be identified as a C2PA manifest store.`,
    );
    return;
  }

  report.c2pa.present = true;
  report.c2pa.locations.push({
    location,
    bytes: typeof reportedBytes === 'number' ? reportedBytes : length,
  });

  if (truncated) {
    report.warnings.push('The credential data was larger or deeper than expected and was only partly read.');
  }

  const summary = summariseC2paStore(boxes);
  report.c2pa.manifestCount += summary.manifests.length;
  for (const label of summary.assertionLabels) {
    if (!report.c2pa.assertionLabels.includes(label)) report.c2pa.assertionLabels.push(label);
  }
  const generator = readClaimGenerator(bytes, offset, offset + length);
  if (generator && !report.c2pa.claimGenerators.includes(generator)) {
    report.c2pa.claimGenerators.push(generator);
  }
}

function makeXmpEntry(bytes, offset, length, location) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(offset, offset + Math.min(length, 65536)),
  );
  return {
    kind: 'xmp',
    label: 'XMP metadata packet',
    location,
    bytes: length,
    hasProvenanceReference: text.includes(XMP_PROVENANCE_HINT),
  };
}

/**
 * Best-effort read of the `claim_generator` string from a C2PA claim.
 *
 * The claim is CBOR. Rather than implement a CBOR parser, we locate the
 * `claim_generator` map key and decode the single text string that follows it,
 * strictly per the CBOR text-string encoding rules. If anything does not match
 * exactly, we return null rather than guess. A wrong attribution would be worse
 * than no attribution.
 *
 * @returns {string|null}
 */
export function readClaimGenerator(bytes, start, end) {
  const key = [0x63, 0x6c, 0x61, 0x69, 0x6d, 0x5f, 0x67, 0x65, 0x6e, 0x65, 0x72, 0x61, 0x74, 0x6f, 0x72]; // "claim_generator"
  const limit = Math.min(end, bytes.length);

  for (let i = start; i + key.length < limit; i += 1) {
    let matched = true;
    for (let k = 0; k < key.length; k += 1) {
      if (bytes[i + k] !== key[k]) { matched = false; break; }
    }
    if (!matched) continue;

    // The key must itself be encoded as a 15-byte CBOR text string (0x6f).
    if (i === start || bytes[i - 1] !== 0x6f) continue;

    const value = readCborTextString(bytes, i + key.length, limit);
    if (value) return value;
  }
  return null;
}

function readCborTextString(bytes, offset, limit) {
  if (offset >= limit) return null;
  const initial = bytes[offset];
  const major = initial >> 5;
  if (major !== 3) return null; // not a text string

  const info = initial & 0x1f;
  let length;
  let dataOffset;
  if (info < 24) { length = info; dataOffset = offset + 1; }
  else if (info === 24) { length = bytes[offset + 1]; dataOffset = offset + 2; }
  else if (info === 25) { length = (bytes[offset + 1] << 8) | bytes[offset + 2]; dataOffset = offset + 3; }
  else return null; // longer or indefinite-length strings: not worth guessing at

  if (length === 0 || dataOffset + length > limit || length > 512) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(dataOffset, dataOffset + length));
  // A generator string should be printable; reject control characters.
  if (/[\u0000-\u001f]/.test(text)) return null;
  return text;
}


/* ------------------------------------------------------------------------ */
/* Diagnostics                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Explain WHY an image was reported the way it was.
 *
 * This exists because "no supported credentials found" has several very
 * different causes, and from the outside they look identical:
 *
 *   a) the file genuinely has no credentials;
 *   b) we fetched a resized or re-encoded copy, and the copy lost them;
 *   c) the file has them somewhere our parser is not looking.
 *
 * Case (c) is a bug in us. Case (b) is a bug in the adapter. Case (a) is not a
 * bug at all. The `rawMarkers` field below is what separates them: it scans
 * the whole file for the byte sequences a C2PA manifest cannot exist without.
 * If those bytes are present but `inspectImage` found no manifest, the parser
 * is at fault. If they are absent, the file really has nothing in it.
 *
 * Goes to the developer console only. Never shown in the interface.
 *
 * @param {Uint8Array} bytes
 * @returns {object} a technical report
 */
export function diagnoseImage(bytes) {
  const report = inspectImage(bytes);
  const diagnosis = {
    byteLength: bytes ? bytes.length : 0,
    format: report.format,
    status: report.status,
    dimensions: report.dimensions,
    firstBytes: bytes ? [...bytes.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ') : '',
    containerBlocks: [],
    rawMarkers: {},
    otherMetadata: report.otherMetadata.map((entry) => `${entry.kind} (${entry.bytes} bytes)`),
    interpretation: '',
  };

  // What blocks does the container actually hold?
  try {
    if (report.format === FORMAT.PNG) {
      const parsed = png.parsePngChunks(bytes);
      diagnosis.containerBlocks = parsed.chunks.map((c) => `${c.type}:${c.dataLength}`);
    } else if (report.format === FORMAT.JPEG) {
      const parsed = jpeg.parseJpegSegments(bytes);
      diagnosis.containerBlocks = parsed.segments.map(
        (seg) => `FF${seg.marker.toString(16).toUpperCase()}:${seg.payloadLength}`,
      );
    } else if (report.format === FORMAT.WEBP) {
      const parsed = webp.parseWebpChunks(bytes);
      diagnosis.containerBlocks = parsed.chunks.map((c) => `${c.fourcc.trim()}:${c.dataLength}`);
    }
  } catch (error) {
    diagnosis.containerBlocks = [`parse failed: ${error && error.message}`];
  }

  // Scan the raw bytes for sequences a C2PA manifest cannot exist without.
  const haystack = bytes ? Buffer_from(bytes) : '';
  for (const marker of ['jumb', 'jumd', 'c2pa', 'caBX', 'C2PA', 'c2ma', 'urn:uuid', 'dcterms:provenance']) {
    diagnosis.rawMarkers[marker] = haystack.includes(marker);
  }

  const anyC2paBytes = ['jumb', 'jumd', 'c2ma'].some((m) => diagnosis.rawMarkers[m]);

  if (report.status === STATUS.CREDENTIALS_DETECTED) {
    diagnosis.interpretation = 'Credentials found and parsed. Nothing to investigate.';
  } else if (anyC2paBytes) {
    diagnosis.interpretation =
      'PARSER PROBLEM: the file contains C2PA byte markers but no manifest was parsed. ' +
      'The credential engine is failing on this file. Please report this diagnosis.';
  } else if (report.status === STATUS.UNSUPPORTED_FORMAT) {
    diagnosis.interpretation = `This file is ${report.formatLabel}, which this version does not read.`;
  } else if (report.status === STATUS.UNREADABLE) {
    diagnosis.interpretation = `The container could not be read: ${report.structureError}`;
  } else {
    diagnosis.interpretation =
      'The file we fetched contains no C2PA bytes at all. Either the original has none, ' +
      'or we fetched a resized or re-encoded copy that lost them. Compare the byte length ' +
      'and dimensions above against the image you can download from the site itself.';
  }

  return diagnosis;
}

/** Decode bytes to a searchable Latin-1 string without a Buffer dependency. */
function Buffer_from(bytes) {
  let text = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return text;
}
