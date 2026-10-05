/**
 * Minimal JPEG marker-segment reader/writer.
 *
 * A JPEG is SOI (FFD8) followed by marker segments. Most segments are
 * FF <marker> <2-byte big-endian length, inclusive of those 2 bytes> <payload>.
 * A handful of markers stand alone with no length at all.
 *
 * Once SOS (FFDA) is reached, the remainder of the file is entropy-coded scan
 * data which must not be parsed as markers. We copy everything from SOS to the
 * end of the file verbatim, which is what makes removal lossless: the
 * compressed image data is never touched or re-encoded.
 */

/** Markers that carry no length field. */
const STANDALONE_MARKERS = new Set([0x01, 0xd8, 0xd9]);
function isRestartMarker(marker) {
  return marker >= 0xd0 && marker <= 0xd7;
}

export const MARKER = {
  SOI: 0xd8,
  EOI: 0xd9,
  SOS: 0xda,
  APP0: 0xe0,
  APP1: 0xe1,
  APP11: 0xeb,
};

const MAX_SEGMENTS = 5000;

/** APP11 payload header, per ISO/IEC 18477-3 (JPEG XT box carriage). */
export const APP11_HEADER_LENGTH = 16; // "JP" + instance(2) + seq(4) + LBox(4) + TBox(4)

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0
  );
}

function fourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Walk the marker segments up to (and including the position of) SOS.
 *
 * @param {Uint8Array} bytes
 * @returns {{ok: boolean, error?: string,
 *   segments: Array<{marker: number, offset: number, totalLength: number,
 *                    payloadOffset: number, payloadLength: number}>,
 *   scanOffset: number|null}}
 */
export function parseJpegSegments(bytes) {
  const segments = [];
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { ok: false, error: 'Not a JPEG file (missing start-of-image marker).', segments, scanOffset: null };
  }

  let offset = 2; // past SOI
  let scanOffset = null;

  while (offset + 1 < bytes.length) {
    if (segments.length >= MAX_SEGMENTS) {
      return { ok: false, error: 'JPEG has an implausible number of segments.', segments, scanOffset };
    }

    // Marker introducer. Fill bytes (repeated FF) are legal padding; skip them.
    if (bytes[offset] !== 0xff) {
      return { ok: false, error: 'JPEG structure is malformed (expected a marker).', segments, scanOffset };
    }
    let markerPos = offset;
    while (markerPos + 1 < bytes.length && bytes[markerPos + 1] === 0xff) markerPos += 1;
    const marker = bytes[markerPos + 1];

    if (marker === MARKER.SOS) {
      scanOffset = markerPos;
      break;
    }
    if (STANDALONE_MARKERS.has(marker) || isRestartMarker(marker)) {
      offset = markerPos + 2;
      continue;
    }

    if (markerPos + 4 > bytes.length) {
      return { ok: false, error: 'JPEG is truncated inside a segment header.', segments, scanOffset };
    }
    const length = readUint16BE(bytes, markerPos + 2);
    if (length < 2 || markerPos + 2 + length > bytes.length) {
      return { ok: false, error: 'JPEG is truncated or has a bad segment length.', segments, scanOffset };
    }

    segments.push({
      marker,
      offset: markerPos,
      totalLength: 2 + length,
      payloadOffset: markerPos + 4,
      payloadLength: length - 2,
    });
    offset = markerPos + 2 + length;
  }

  if (scanOffset === null) {
    return { ok: false, error: 'JPEG contains no image scan data.', segments, scanOffset: null };
  }
  return { ok: true, segments, scanOffset };
}

/**
 * Read the JPEG-XT/JUMBF header out of an APP11 segment payload.
 *
 * Layout: "JP" | box instance number (2) | packet sequence number (4) |
 *         LBox (4) | TBox (4) | payload bytes
 *
 * A manifest store larger than a single 64 KiB segment is split across several
 * contiguous APP11 segments that share a box instance number and carry
 * increasing packet sequence numbers.
 */
export function readApp11Header(bytes, segment) {
  if (segment.marker !== MARKER.APP11 || segment.payloadLength < APP11_HEADER_LENGTH) return null;
  const base = segment.payloadOffset;
  if (bytes[base] !== 0x4a || bytes[base + 1] !== 0x50) return null; // "JP"
  return {
    boxInstance: readUint16BE(bytes, base + 2),
    packetSequence: readUint32BE(bytes, base + 4),
    lbox: readUint32BE(bytes, base + 8),
    tbox: fourCC(bytes, base + 12),
    boxDataOffset: base + APP11_HEADER_LENGTH,
    boxDataLength: segment.payloadLength - APP11_HEADER_LENGTH,
  };
}

/** Does an APP1 segment hold EXIF? */
export function isExifSegment(bytes, segment) {
  if (segment.marker !== MARKER.APP1 || segment.payloadLength < 6) return false;
  return (
    fourCC(bytes, segment.payloadOffset) === 'Exif' &&
    bytes[segment.payloadOffset + 4] === 0x00
  );
}

const XMP_NAMESPACE = 'http://ns.adobe.com/xap/1.0/';

/** Does an APP1 segment hold an XMP packet? */
export function isXmpSegment(bytes, segment) {
  if (segment.marker !== MARKER.APP1 || segment.payloadLength < XMP_NAMESPACE.length + 1) return false;
  let header = '';
  for (let i = 0; i < XMP_NAMESPACE.length; i += 1) {
    header += String.fromCharCode(bytes[segment.payloadOffset + i]);
  }
  return header === XMP_NAMESPACE;
}

/**
 * Rebuild a JPEG from the original buffer: SOI, the kept segments in order, then
 * the scan data through to the end of file, all copied byte-for-byte.
 *
 * @param {Uint8Array} bytes
 * @param {Array<{offset: number, totalLength: number}>} keptSegments
 * @param {number} scanOffset
 * @returns {Uint8Array}
 */
export function serialiseJpegSegments(bytes, keptSegments, scanOffset) {
  const tailLength = bytes.length - scanOffset;
  let size = 2 + tailLength; // SOI + scan data through EOI
  for (const segment of keptSegments) size += segment.totalLength;

  const out = new Uint8Array(size);
  out[0] = 0xff;
  out[1] = 0xd8;
  let cursor = 2;
  for (const segment of keptSegments) {
    out.set(bytes.subarray(segment.offset, segment.offset + segment.totalLength), cursor);
    cursor += segment.totalLength;
  }
  out.set(bytes.subarray(scanOffset), cursor);
  return out;
}

/** Read dimensions from the start-of-frame header, so we can verify they survive. */
export function readJpegDimensions(bytes, segments) {
  // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  const sof = segments.find((segment) => sofMarkers.has(segment.marker));
  if (!sof || sof.payloadLength < 5) return null;
  return {
    height: readUint16BE(bytes, sof.payloadOffset + 1),
    width: readUint16BE(bytes, sof.payloadOffset + 3),
  };
}

/**
 * Reassemble a JUMBF box that was split across several APP11 segments.
 *
 * Verified against real C2PA-signed JPEGs: every segment of one box instance
 * repeats the 16-byte APP11 header (including LBox and TBox) and carries the
 * next slice of the box payload. The box's LBox counts the 8-byte LBox/TBox
 * header plus the concatenated payload slices, so reassembly is:
 *
 *   LBox + TBox (taken once from the first segment) || payload slices in
 *   packet-sequence order
 *
 * @param {Uint8Array} bytes
 * @param {Array<object>} segments APP11 segments sharing one box instance
 * @returns {{bytes: Uint8Array, declaredLength: number}|null}
 */
export function reassembleApp11Box(bytes, segments) {
  if (!segments || segments.length === 0) return null;

  const ordered = [...segments].sort((a, b) => {
    const left = readApp11Header(bytes, a);
    const right = readApp11Header(bytes, b);
    if (!left || !right) return a.offset - b.offset;
    if (left.packetSequence !== right.packetSequence) {
      return left.packetSequence - right.packetSequence;
    }
    return a.offset - b.offset;
  });

  const first = readApp11Header(bytes, ordered[0]);
  if (!first) return null;

  let payloadLength = 0;
  for (const segment of ordered) {
    const header = readApp11Header(bytes, segment);
    if (!header) return null;
    payloadLength += header.boxDataLength;
  }

  const out = new Uint8Array(8 + payloadLength);
  // LBox and TBox, copied from the first segment.
  out.set(bytes.subarray(first.boxDataOffset - 8, first.boxDataOffset), 0);
  let cursor = 8;
  for (const segment of ordered) {
    const header = readApp11Header(bytes, segment);
    out.set(bytes.subarray(header.boxDataOffset, header.boxDataOffset + header.boxDataLength), cursor);
    cursor += header.boxDataLength;
  }
  return { bytes: out, declaredLength: first.lbox };
}
