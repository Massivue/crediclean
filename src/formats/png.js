/**
 * Minimal PNG chunk reader/writer.
 *
 * A PNG is an 8-byte signature followed by a flat list of chunks, each laid out
 * as: length (4 bytes, big-endian) | type (4 ASCII bytes) | data | CRC32 (4 bytes).
 *
 * The length field covers only `data`, and each chunk carries its own CRC. That
 * means whole chunks can be dropped without recomputing anything and without
 * touching the compressed pixel data in the IDAT chunks. Removal is therefore
 * byte-exact for every chunk we keep, and pixel-for-pixel lossless.
 */

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** C2PA manifest store chunk. Ancillary, private, not-safe-to-copy. */
export const C2PA_CHUNK_TYPE = 'caBX';

/** XMP is carried in an iTXt chunk with this keyword. */
export const XMP_ITXT_KEYWORD = 'XML:com.adobe.xmp';

/** Hard ceiling on chunk count, to stop a malformed file spinning us forever. */
const MAX_CHUNKS = 10000;

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0
  );
}

function writeUint32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function chunkTypeAt(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Walk the chunk list.
 *
 * @param {Uint8Array} bytes
 * @returns {{ok: boolean, error?: string, chunks: Array<{type: string, offset: number,
 *   dataOffset: number, dataLength: number, totalLength: number}>, truncated: boolean}}
 */
export function parsePngChunks(bytes) {
  const chunks = [];
  if (bytes.length < 8) {
    return { ok: false, error: 'File is too short to be a PNG.', chunks, truncated: true };
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return { ok: false, error: 'Not a PNG file (bad signature).', chunks, truncated: false };
    }
  }

  let offset = 8;
  let truncated = false;

  while (offset + 8 <= bytes.length) {
    if (chunks.length >= MAX_CHUNKS) {
      return { ok: false, error: 'PNG has an implausible number of chunks.', chunks, truncated };
    }
    const dataLength = readUint32BE(bytes, offset);
    const type = chunkTypeAt(bytes, offset + 4);
    const totalLength = 12 + dataLength;

    // A chunk that claims to run past the end of the buffer means the file is
    // truncated or corrupt. Stop rather than read out of bounds.
    if (dataLength > 0x7fffffff || offset + totalLength > bytes.length) {
      truncated = true;
      break;
    }

    chunks.push({ type, offset, dataOffset: offset + 8, dataLength, totalLength });
    offset += totalLength;

    if (type === 'IEND') break;
  }

  if (chunks.length === 0) {
    return { ok: false, error: 'PNG contains no readable chunks.', chunks, truncated };
  }
  return { ok: true, chunks, truncated };
}

/**
 * Rebuild a PNG from the original buffer, keeping only the chunks whose
 * descriptors are passed in. Kept chunks are copied byte-for-byte.
 *
 * @param {Uint8Array} bytes original file
 * @param {Array<{offset: number, totalLength: number}>} keptChunks in file order
 * @returns {Uint8Array}
 */
export function serialisePngChunks(bytes, keptChunks) {
  let size = PNG_SIGNATURE.length;
  for (const chunk of keptChunks) size += chunk.totalLength;

  const out = new Uint8Array(size);
  out.set(PNG_SIGNATURE, 0);
  let cursor = PNG_SIGNATURE.length;
  for (const chunk of keptChunks) {
    out.set(bytes.subarray(chunk.offset, chunk.offset + chunk.totalLength), cursor);
    cursor += chunk.totalLength;
  }
  return out;
}

/** Decode the keyword of an iTXt chunk (NUL-terminated Latin-1 at the start of the data). */
export function readITXtKeyword(bytes, chunk) {
  const end = Math.min(chunk.dataOffset + 80, chunk.dataOffset + chunk.dataLength);
  let keyword = '';
  for (let i = chunk.dataOffset; i < end; i += 1) {
    if (bytes[i] === 0) return keyword;
    keyword += String.fromCharCode(bytes[i]);
  }
  return keyword;
}

/** Read the image dimensions out of IHDR, so we can prove they survive processing. */
export function readPngDimensions(bytes, chunks) {
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr || ihdr.dataLength < 8) return null;
  return {
    width: readUint32BE(bytes, ihdr.dataOffset),
    height: readUint32BE(bytes, ihdr.dataOffset + 4),
  };
}

export const __internal = { readUint32BE, writeUint32BE };
