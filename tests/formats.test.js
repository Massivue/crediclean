/** Format detection and container round-tripping. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FORMAT, detectFormat, extensionFor, mimeTypeFor, isSupportedFormat } from '../src/formats/detect.js';
import * as png from '../src/formats/png.js';
import * as jpeg from '../src/formats/jpeg.js';
import * as webp from '../src/formats/webp.js';
import { buildPng, buildJpeg, buildWebp, buildC2paManifestStore, concat } from './fixtures.js';

test('detects each supported format from its bytes alone', () => {
  assert.equal(detectFormat(buildPng()), FORMAT.PNG);
  assert.equal(detectFormat(buildJpeg()), FORMAT.JPEG);
  assert.equal(detectFormat(buildWebp()), FORMAT.WEBP);
});

test('detects unsupported formats rather than guessing', () => {
  const gif = concat([Uint8Array.from('GIF89a', (c) => c.charCodeAt(0)), new Uint8Array(32)]);
  assert.equal(detectFormat(gif), FORMAT.GIF);
  assert.equal(isSupportedFormat(FORMAT.GIF), false);

  const svg = Uint8Array.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>', (c) => c.charCodeAt(0));
  assert.equal(detectFormat(svg), FORMAT.SVG);

  const avif = concat([new Uint8Array(4), Uint8Array.from('ftypavif', (c) => c.charCodeAt(0)), new Uint8Array(16)]);
  assert.equal(detectFormat(avif), FORMAT.AVIF);
});

test('returns unknown for junk and for empty input, never a false positive', () => {
  assert.equal(detectFormat(new Uint8Array(0)), FORMAT.UNKNOWN);
  assert.equal(detectFormat(new Uint8Array(4)), FORMAT.UNKNOWN);
  assert.equal(detectFormat(new Uint8Array(64).fill(0x42)), FORMAT.UNKNOWN);
  assert.equal(detectFormat(null), FORMAT.UNKNOWN);
});

test('file extension and mime type follow the detected format', () => {
  assert.equal(extensionFor(FORMAT.JPEG), 'jpg');
  assert.equal(extensionFor(FORMAT.PNG), 'png');
  assert.equal(extensionFor(FORMAT.WEBP), 'webp');
  assert.equal(mimeTypeFor(FORMAT.PNG), 'image/png');
  assert.equal(mimeTypeFor(FORMAT.UNKNOWN), 'application/octet-stream');
});

test('PNG rebuilt from all its own chunks is byte-identical', () => {
  const bytes = buildPng({ c2pa: buildC2paManifestStore(), xmp: 'plain' });
  const parsed = png.parsePngChunks(bytes);
  assert.equal(parsed.ok, true);
  const rebuilt = png.serialisePngChunks(bytes, parsed.chunks);
  assert.deepEqual(Buffer.from(rebuilt), Buffer.from(bytes));
});

test('JPEG rebuilt from all its own segments is byte-identical', () => {
  const bytes = buildJpeg({ c2pa: buildC2paManifestStore(), xmp: 'plain' });
  const parsed = jpeg.parseJpegSegments(bytes);
  assert.equal(parsed.ok, true);
  const rebuilt = jpeg.serialiseJpegSegments(bytes, parsed.segments, parsed.scanOffset);
  assert.deepEqual(Buffer.from(rebuilt), Buffer.from(bytes));
});

test('WebP rebuilt from all its own chunks is byte-identical', () => {
  const bytes = buildWebp({ c2pa: buildC2paManifestStore(), xmp: 'plain' });
  const parsed = webp.parseWebpChunks(bytes);
  assert.equal(parsed.ok, true);
  const rebuilt = webp.serialiseWebpChunks(bytes, parsed.chunks);
  assert.deepEqual(Buffer.from(rebuilt), Buffer.from(bytes));
});

test('a truncated PNG is reported, not read past the end of the buffer', () => {
  const bytes = buildPng({ c2pa: buildC2paManifestStore() });
  const parsed = png.parsePngChunks(bytes.subarray(0, bytes.length - 40));
  assert.equal(parsed.truncated, true);
});

test('a PNG with a bad signature is rejected', () => {
  const bytes = buildPng();
  bytes[1] = 0x00;
  const parsed = png.parsePngChunks(bytes);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /signature/i);
});

test('a JPEG with no scan data is rejected rather than half-parsed', () => {
  const parsed = jpeg.parseJpegSegments(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /scan data/i);
});

test('a JPEG segment claiming a length past the end of file is rejected', () => {
  const bytes = buildJpeg();
  // Overstate the APP0 length.
  bytes[4] = 0xff;
  bytes[5] = 0xff;
  const parsed = jpeg.parseJpegSegments(bytes);
  assert.equal(parsed.ok, false);
});

test('APP11 reassembly restores a box split across segments', () => {
  const store = buildC2paManifestStore({ padding: 150000 });
  const bytes = buildJpeg({ c2pa: store, maxApp11Payload: 60000 });
  const parsed = jpeg.parseJpegSegments(bytes);
  const app11 = parsed.segments.filter((segment) => segment.marker === jpeg.MARKER.APP11);

  assert.ok(app11.length > 1, 'fixture should produce a split box');
  const reassembled = jpeg.reassembleApp11Box(bytes, app11);
  assert.deepEqual(Buffer.from(reassembled.bytes), Buffer.from(store));
  assert.equal(reassembled.declaredLength, store.length);
});

test('dimensions are read from each container', () => {
  const p = buildPng({ width: 7, height: 9 });
  assert.deepEqual(png.readPngDimensions(p, png.parsePngChunks(p).chunks), { width: 7, height: 9 });

  const j = buildJpeg({ width: 33, height: 21 });
  assert.deepEqual(jpeg.readJpegDimensions(j, jpeg.parseJpegSegments(j).segments), { width: 33, height: 21 });

  const w = buildWebp({ width: 64, height: 48 });
  assert.deepEqual(webp.readWebpDimensions(w, webp.parseWebpChunks(w).chunks), { width: 64, height: 48 });
});
