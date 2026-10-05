/**
 * Builders for synthetic test images.
 *
 * The tests construct their own files rather than committing binaries, so the
 * suite is deterministic, needs no network, and ships no third-party assets.
 *
 * The C2PA blocks these builders produce are structurally genuine: a real
 * JUMBF superbox with the C2PA UUID and label, as read out of real signed
 * images during development. They are not cryptographically signed, which does
 * not matter here because the extension detects and removes manifests rather
 * than validating them.
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(value) {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u16be(value) {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32le(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function ascii(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

export function concat(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* JUMBF                                                               */
/* ------------------------------------------------------------------ */

/** A description box: UUID, toggles, then a NUL-terminated label. */
function jumdBox(uuidPrefix, label) {
  const uuid = new Uint8Array(16);
  uuid.set(ascii(uuidPrefix).subarray(0, 4), 0);
  // Remaining bytes mirror the fixed tail used by the C2PA UUIDs.
  uuid.set([0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 4);
  const body = concat([uuid, Uint8Array.of(0x03), ascii(label), Uint8Array.of(0)]);
  return concat([u32be(body.length + 8), ascii('jumd'), body]);
}

/** A superbox: its description box followed by its content boxes. */
function jumbBox(uuidPrefix, label, contents = []) {
  const body = concat([jumdBox(uuidPrefix, label), ...contents]);
  return concat([u32be(body.length + 8), ascii('jumb'), body]);
}

/**
 * Build a C2PA manifest store containing one manifest with the given
 * assertions, plus a claim carrying a `claim_generator` string in CBOR.
 */
export function buildC2paManifestStore({
  assertions = ['c2pa.actions', 'c2pa.hash.data'],
  claimGenerator = 'TestGenerator/1.0',
  padding = 0,
} = {}) {
  const assertionBoxes = assertions.map((label) => jumbBox('c2as', label, [cborBox(label)]));
  const assertionStore = jumbBox('c2as', 'c2pa.assertions', assertionBoxes);
  const claim = jumbBox('c2cl', 'c2pa.claim', [cborBox(null, buildClaimCbor(claimGenerator))]);
  const manifest = jumbBox('c2ma', 'urn:uuid:00000000-0000-4000-8000-000000000001', [assertionStore, claim]);

  const extras = padding > 0 ? [jumbBox('c2pd', 'c2pa.padding', [cborBox(null, new Uint8Array(padding))])] : [];
  return jumbBox('c2pa', 'c2pa', [manifest, ...extras]);
}

function cborBox(label, payload) {
  const body = payload || ascii(label || 'x');
  return concat([u32be(body.length + 8), ascii('cbor'), body]);
}

/** A tiny CBOR map: {"claim_generator": "<text>"} */
function buildClaimCbor(generator) {
  const key = ascii('claim_generator');
  const value = ascii(generator);
  const parts = [
    Uint8Array.of(0xa1), // map, 1 pair
    Uint8Array.of(0x60 | key.length), // text string, 15 bytes
    key,
  ];
  if (value.length < 24) parts.push(Uint8Array.of(0x60 | value.length));
  else if (value.length < 256) parts.push(Uint8Array.of(0x78, value.length));
  else parts.push(Uint8Array.of(0x79, (value.length >> 8) & 0xff, value.length & 0xff));
  parts.push(value);
  return concat(parts);
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

function pngChunk(type, data) {
  const typeBytes = ascii(type);
  const body = concat([typeBytes, data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

const XMP_WITH_PROVENANCE =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description dcterms:provenance="self#jumbf=c2pa"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

const XMP_WITHOUT_PROVENANCE =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description dc:creator="A Person"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

function xmpITXtData(xmp) {
  // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
  return concat([
    ascii('XML:com.adobe.xmp'),
    Uint8Array.of(0, 0, 0),
    Uint8Array.of(0),
    Uint8Array.of(0),
    ascii(xmp),
  ]);
}

/**
 * Build a valid, decodable PNG.
 *
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {Uint8Array|null} [options.c2pa] manifest store bytes, or null
 * @param {'none'|'provenance'|'plain'} [options.xmp]
 */
export function buildPng({ width = 4, height = 4, c2pa = null, xmp = 'none' } = {}) {
  const ihdr = concat([u32be(width), u32be(height), Uint8Array.of(8, 6, 0, 0, 0)]);

  // Raw RGBA scanlines, each preceded by filter type 0.
  const raw = new Uint8Array(height * (1 + width * 4));
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    raw[cursor] = 0;
    cursor += 1;
    for (let x = 0; x < width; x += 1) {
      raw[cursor] = (x * 37 + y * 11) & 0xff;
      raw[cursor + 1] = (x * 53 + y * 29) & 0xff;
      raw[cursor + 2] = (x * 17 + y * 71) & 0xff;
      raw[cursor + 3] = 0xff;
      cursor += 4;
    }
  }

  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
  ];
  if (c2pa) parts.push(pngChunk('caBX', c2pa));
  if (xmp === 'provenance') parts.push(pngChunk('iTXt', xmpITXtData(XMP_WITH_PROVENANCE)));
  if (xmp === 'plain') parts.push(pngChunk('iTXt', xmpITXtData(XMP_WITHOUT_PROVENANCE)));
  parts.push(pngChunk('IDAT', new Uint8Array(zlib.deflateSync(Buffer.from(raw)))));
  parts.push(pngChunk('IEND', new Uint8Array(0)));

  return concat(parts);
}

/* ------------------------------------------------------------------ */
/* JPEG                                                                */
/* ------------------------------------------------------------------ */

function segment(marker, payload) {
  return concat([Uint8Array.of(0xff, marker), u16be(payload.length + 2), payload]);
}

/**
 * Split a JUMBF box across APP11 segments the way the specification requires:
 * each segment repeats the 16-byte header, and the box's LBox counts the
 * 8-byte LBox/TBox plus every payload slice.
 */
function app11Segments(boxBytes, boxInstance, maxPayload) {
  const header = boxBytes.subarray(0, 8); // LBox + TBox
  const payload = boxBytes.subarray(8);
  const segments = [];
  let offset = 0;
  let sequence = 1;

  while (offset < payload.length) {
    const slice = payload.subarray(offset, offset + maxPayload);
    segments.push(
      segment(
        0xeb,
        concat([
          ascii('JP'),
          u16be(boxInstance),
          u32be(sequence),
          header, // LBox + TBox repeated in every segment
          slice,
        ]),
      ),
    );
    offset += slice.length;
    sequence += 1;
  }
  return segments;
}

/**
 * Build a structurally valid JPEG.
 *
 * The entropy-coded scan is filler rather than real Huffman data: nothing in
 * CrediClean decodes it, and the tests that matter assert it is copied through
 * byte-for-byte. Tests that need a genuinely decodable JPEG use the real
 * downloaded samples instead (see tests/real-samples.test.js).
 */
export function buildJpeg({
  width = 16,
  height = 12,
  c2pa = null,
  boxInstance = 0x0211,
  maxApp11Payload = 65000,
  xmp = 'none',
  scanBytes = 512,
} = {}) {
  const parts = [Uint8Array.of(0xff, 0xd8)];

  parts.push(segment(0xe0, concat([ascii('JFIF'), Uint8Array.of(0, 1, 2, 0, 0, 1, 0, 1, 0, 0)])));

  if (c2pa) parts.push(...app11Segments(c2pa, boxInstance, maxApp11Payload));

  if (xmp === 'provenance') {
    parts.push(segment(0xe1, concat([ascii('http://ns.adobe.com/xap/1.0/'), Uint8Array.of(0), ascii(XMP_WITH_PROVENANCE)])));
  } else if (xmp === 'plain') {
    parts.push(segment(0xe1, concat([ascii('http://ns.adobe.com/xap/1.0/'), Uint8Array.of(0), ascii(XMP_WITHOUT_PROVENANCE)])));
  }

  // A quantisation table, so the file carries the segments a real JPEG has.
  parts.push(segment(0xdb, concat([Uint8Array.of(0), new Uint8Array(64).fill(16)])));
  // SOF0: precision, height, width, one component.
  parts.push(segment(0xc0, concat([Uint8Array.of(8), u16be(height), u16be(width), Uint8Array.of(1, 1, 0x11, 0)])));
  // A Huffman table.
  parts.push(segment(0xc4, concat([Uint8Array.of(0), new Uint8Array(16), new Uint8Array(0)])));
  // SOS, then filler scan data, then EOI.
  parts.push(segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)));

  const scan = new Uint8Array(scanBytes);
  for (let i = 0; i < scan.length; i += 1) scan[i] = (i * 7 + 3) & 0x7f; // never 0xFF
  parts.push(scan);
  parts.push(Uint8Array.of(0xff, 0xd9));

  return concat(parts);
}

/* ------------------------------------------------------------------ */
/* WebP                                                                */
/* ------------------------------------------------------------------ */

function riffChunk(fourcc, data) {
  const padded = data.length & 1 ? concat([data, Uint8Array.of(0)]) : data;
  return concat([ascii(fourcc), u32le(data.length), padded]);
}

/** Build a WebP whose VP8L header encodes the given dimensions. */
export function buildWebp({ width = 32, height = 24, c2pa = null, xmp = 'none', payloadBytes = 64 } = {}) {
  // VP8L: signature byte 0x2f, then 14 bits width-1, 14 bits height-1.
  const bits = (width - 1) | ((height - 1) << 14);
  const vp8l = concat([
    Uint8Array.of(0x2f),
    u32le(bits >>> 0),
    new Uint8Array(payloadBytes).map((_, index) => (index * 13 + 5) & 0xff),
  ]);

  const chunks = [];
  if (c2pa) chunks.push(riffChunk('C2PA', c2pa));
  if (xmp === 'provenance') chunks.push(riffChunk('XMP ', ascii(XMP_WITH_PROVENANCE)));
  if (xmp === 'plain') chunks.push(riffChunk('XMP ', ascii(XMP_WITHOUT_PROVENANCE)));
  chunks.push(riffChunk('VP8L', vp8l));

  const body = concat(chunks);
  return concat([ascii('RIFF'), u32le(4 + body.length), ascii('WEBP'), body]);
}

export const SAMPLE_XMP = { withProvenance: XMP_WITH_PROVENANCE, withoutProvenance: XMP_WITHOUT_PROVENANCE };
