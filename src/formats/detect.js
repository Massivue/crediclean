/**
 * Byte-signature based image format detection.
 *
 * We deliberately do NOT trust the HTTP Content-Type header or the URL
 * extension. ChatGPT serves images from signed CDN URLs that often carry no
 * useful extension, and a wrong format guess would make us parse a file with
 * the wrong structural rules.
 */

export const FORMAT = {
  PNG: 'png',
  JPEG: 'jpeg',
  WEBP: 'webp',
  GIF: 'gif',
  AVIF: 'avif',
  HEIC: 'heic',
  TIFF: 'tiff',
  SVG: 'svg',
  UNKNOWN: 'unknown',
};

/** Human-facing names, used in the UI. */
export const FORMAT_LABELS = {
  [FORMAT.PNG]: 'PNG',
  [FORMAT.JPEG]: 'JPEG',
  [FORMAT.WEBP]: 'WebP',
  [FORMAT.GIF]: 'GIF',
  [FORMAT.AVIF]: 'AVIF',
  [FORMAT.HEIC]: 'HEIC',
  [FORMAT.TIFF]: 'TIFF',
  [FORMAT.SVG]: 'SVG',
  [FORMAT.UNKNOWN]: 'unrecognised format',
};

/** Formats whose container structure this extension can parse and rewrite. */
export const SUPPORTED_FORMATS = [FORMAT.PNG, FORMAT.JPEG, FORMAT.WEBP];

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_SIG = [0x47, 0x49, 0x46, 0x38]; // "GIF8"
const RIFF_SIG = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIG = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a];

/** ISO-BMFF brands we care about, read from the `ftyp` box at offset 4. */
const ISO_BRANDS = {
  avif: FORMAT.AVIF,
  avis: FORMAT.AVIF,
  heic: FORMAT.HEIC,
  heix: FORMAT.HEIC,
  hevc: FORMAT.HEIC,
  mif1: FORMAT.HEIC,
};

/**
 * @param {Uint8Array} bytes
 * @returns {string} one of FORMAT.*
 */
export function detectFormat(bytes) {
  if (!bytes || bytes.length < 12) return FORMAT.UNKNOWN;

  if (startsWith(bytes, PNG_SIG)) return FORMAT.PNG;

  // JPEG: SOI (FFD8) immediately followed by any marker introducer (FF).
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return FORMAT.JPEG;

  if (startsWith(bytes, RIFF_SIG) && startsWith(bytes, WEBP_SIG, 8)) return FORMAT.WEBP;

  if (startsWith(bytes, GIF_SIG)) return FORMAT.GIF;

  if (startsWith(bytes, TIFF_LE) || startsWith(bytes, TIFF_BE)) return FORMAT.TIFF;

  // ISO base media file format: [4-byte size]"ftyp"[4-byte brand]
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (ISO_BRANDS[brand]) return ISO_BRANDS[brand];
  }

  // SVG is text; sniff a little way in, skipping any BOM/whitespace/XML prolog.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
    .toLowerCase();
  if (head.includes('<svg')) return FORMAT.SVG;

  return FORMAT.UNKNOWN;
}

export function isSupportedFormat(format) {
  return SUPPORTED_FORMATS.includes(format);
}

/** File extension to use when writing this format back out. */
export function extensionFor(format) {
  switch (format) {
    case FORMAT.PNG: return 'png';
    case FORMAT.JPEG: return 'jpg';
    case FORMAT.WEBP: return 'webp';
    case FORMAT.GIF: return 'gif';
    case FORMAT.AVIF: return 'avif';
    case FORMAT.HEIC: return 'heic';
    case FORMAT.TIFF: return 'tiff';
    case FORMAT.SVG: return 'svg';
    default: return 'bin';
  }
}

export function mimeTypeFor(format) {
  switch (format) {
    case FORMAT.PNG: return 'image/png';
    case FORMAT.JPEG: return 'image/jpeg';
    case FORMAT.WEBP: return 'image/webp';
    case FORMAT.GIF: return 'image/gif';
    case FORMAT.AVIF: return 'image/avif';
    case FORMAT.HEIC: return 'image/heic';
    case FORMAT.TIFF: return 'image/tiff';
    case FORMAT.SVG: return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}
