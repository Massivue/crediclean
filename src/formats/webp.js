/**
 * Minimal WebP (RIFF) chunk reader/writer.
 *
 * A WebP file is: "RIFF" | file size (4 bytes, little-endian, counted from
 * after that field) | "WEBP" | a flat list of chunks. Each chunk is:
 * FourCC (4 bytes) | size (4 bytes, little-endian) | data | one pad byte if
 * size is odd.
 *
 * Dropping a whole chunk is lossless for the remaining chunks; the only value
 * that has to be corrected is the RIFF file-size field in the header.
 *
 * NOTE ON VERIFICATION: the C2PA specification assigns the FourCC "C2PA" to the
 * manifest store chunk in WebP. We were unable to obtain a real
 * C2PA-signed WebP sample to test against, so this path is implemented from the
 * specification but is NOT empirically verified. See docs/FEASIBILITY.md.
 */

/** C2PA manifest store chunk FourCC in a RIFF/WebP container. */
export const C2PA_CHUNK_FOURCC = 'C2PA';

/** WebP carries XMP in an "XMP " chunk and EXIF in an "EXIF" chunk. */
export const XMP_CHUNK_FOURCC = 'XMP ';
export const EXIF_CHUNK_FOURCC = 'EXIF';

const RIFF_HEADER_LENGTH = 12; // "RIFF" + size + "WEBP"
const MAX_CHUNKS = 10000;

function readUint32LE(bytes, offset) {
  return (
    ((bytes[offset]) |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>> 0
  );
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function fourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ok: boolean, error?: string, chunks: Array<{fourcc: string, offset: number,
 *   dataOffset: number, dataLength: number, totalLength: number}>, truncated: boolean}}
 */
export function parseWebpChunks(bytes) {
  const chunks = [];
  if (bytes.length < RIFF_HEADER_LENGTH) {
    return { ok: false, error: 'File is too short to be a WebP.', chunks, truncated: true };
  }
  if (fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WEBP') {
    return { ok: false, error: 'Not a WebP file (bad RIFF header).', chunks, truncated: false };
  }

  let offset = RIFF_HEADER_LENGTH;
  let truncated = false;

  while (offset + 8 <= bytes.length) {
    if (chunks.length >= MAX_CHUNKS) {
      return { ok: false, error: 'WebP has an implausible number of chunks.', chunks, truncated };
    }
    const id = fourCC(bytes, offset);
    const dataLength = readUint32LE(bytes, offset + 4);
    const padded = dataLength + (dataLength & 1);
    const totalLength = 8 + padded;

    if (dataLength > 0x7fffffff || offset + totalLength > bytes.length) {
      // Tolerate a final chunk whose padding byte was never written.
      if (offset + 8 + dataLength <= bytes.length) {
        chunks.push({ fourcc: id, offset, dataOffset: offset + 8, dataLength, totalLength: 8 + dataLength });
      }
      truncated = true;
      break;
    }

    chunks.push({ fourcc: id, offset, dataOffset: offset + 8, dataLength, totalLength });
    offset += totalLength;
  }

  if (chunks.length === 0) {
    return { ok: false, error: 'WebP contains no readable chunks.', chunks, truncated };
  }
  return { ok: true, chunks, truncated };
}

/**
 * Rebuild a WebP, keeping only the given chunks and fixing up the RIFF size.
 *
 * @param {Uint8Array} bytes
 * @param {Array<{offset: number, totalLength: number}>} keptChunks in file order
 * @returns {Uint8Array}
 */
export function serialiseWebpChunks(bytes, keptChunks) {
  let payloadSize = 0;
  for (const chunk of keptChunks) payloadSize += chunk.totalLength;

  const out = new Uint8Array(RIFF_HEADER_LENGTH + payloadSize);
  out.set(bytes.subarray(0, RIFF_HEADER_LENGTH), 0);
  // The RIFF size field counts every byte after the size field itself:
  // the "WEBP" FourCC plus all chunk bytes.
  writeUint32LE(out, 4, 4 + payloadSize);

  let cursor = RIFF_HEADER_LENGTH;
  for (const chunk of keptChunks) {
    out.set(bytes.subarray(chunk.offset, chunk.offset + chunk.totalLength), cursor);
    cursor += chunk.totalLength;
  }
  return out;
}

/** Read dimensions from VP8X, VP8L or VP8 so we can verify they survive. */
export function readWebpDimensions(bytes, chunks) {
  const vp8x = chunks.find((chunk) => chunk.fourcc === 'VP8X');
  if (vp8x && vp8x.dataLength >= 10) {
    const base = vp8x.dataOffset + 4;
    const width = 1 + (bytes[base] | (bytes[base + 1] << 8) | (bytes[base + 2] << 16));
    const height = 1 + (bytes[base + 3] | (bytes[base + 4] << 8) | (bytes[base + 5] << 16));
    return { width, height };
  }
  const vp8 = chunks.find((chunk) => chunk.fourcc === 'VP8 ');
  if (vp8 && vp8.dataLength >= 10) {
    // Lossy bitstream: 3-byte frame tag, 3-byte start code, then 16-bit w/h
    // where the top 2 bits are a scaling hint.
    const base = vp8.dataOffset + 6;
    const width = (bytes[base] | (bytes[base + 1] << 8)) & 0x3fff;
    const height = (bytes[base + 2] | (bytes[base + 3] << 8)) & 0x3fff;
    return { width, height };
  }
  const vp8l = chunks.find((chunk) => chunk.fourcc === 'VP8L');
  if (vp8l && vp8l.dataLength >= 5) {
    const base = vp8l.dataOffset + 1;
    const bits = bytes[base] | (bytes[base + 1] << 8) | (bytes[base + 2] << 16) | (bytes[base + 3] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export const __internal = { readUint32LE, writeUint32LE };
