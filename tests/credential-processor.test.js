/** Removal: that it works, that it is lossless, and that it refuses to lie. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { removeCredentials, OUTCOME, verifyRemoval, comparePixelData } from '../src/processing/credential-processor.js';
import { inspectImage, STATUS } from '../src/processing/metadata-inspector.js';
import { FORMAT } from '../src/formats/detect.js';
import * as png from '../src/formats/png.js';
import * as jpeg from '../src/formats/jpeg.js';
import { buildPng, buildJpeg, buildWebp, buildC2paManifestStore, concat } from './fixtures.js';

const CASES = [
  { name: 'PNG', build: (store, xmp) => buildPng({ c2pa: store, xmp }), format: FORMAT.PNG },
  { name: 'JPEG', build: (store, xmp) => buildJpeg({ c2pa: store, xmp }), format: FORMAT.JPEG },
  { name: 'WebP', build: (store, xmp) => buildWebp({ c2pa: store, xmp }), format: FORMAT.WEBP },
];

for (const testCase of CASES) {
  test(`${testCase.name}: credentials are removed and the result verifies`, () => {
    const bytes = testCase.build(buildC2paManifestStore(), 'none');
    const result = removeCredentials(bytes);

    assert.equal(result.outcome, OUTCOME.REMOVED);
    assert.equal(result.ok, true);
    assert.equal(result.verification.ok, true);
    for (const check of result.verification.checks) {
      assert.equal(check.passed, true, `check should pass: ${check.name} (${check.detail})`);
    }
  });

  test(`${testCase.name}: the output no longer reports any credentials`, () => {
    const bytes = testCase.build(buildC2paManifestStore(), 'none');
    const result = removeCredentials(bytes);
    const after = inspectImage(result.output);

    assert.equal(after.status, STATUS.NO_CREDENTIALS_DETECTED);
    assert.equal(after.c2pa.present, false);
    assert.equal(after.format, testCase.format);
  });

  test(`${testCase.name}: the original buffer is never modified`, () => {
    const bytes = testCase.build(buildC2paManifestStore(), 'provenance');
    const before = Buffer.from(bytes);
    removeCredentials(bytes);
    assert.deepEqual(Buffer.from(bytes), before);
  });

  test(`${testCase.name}: dimensions are unchanged`, () => {
    const bytes = testCase.build(buildC2paManifestStore(), 'none');
    const result = removeCredentials(bytes);
    assert.deepEqual(inspectImage(result.output).dimensions, inspectImage(bytes).dimensions);
  });

  test(`${testCase.name}: pixel data is byte-for-byte identical, so nothing was re-encoded`, () => {
    const bytes = testCase.build(buildC2paManifestStore(), 'none');
    const result = removeCredentials(bytes);
    const comparison = comparePixelData(bytes, result.output, testCase.format);
    assert.equal(comparison.identical, true, comparison.detail);
  });

  test(`${testCase.name}: the file gets smaller by roughly the manifest size`, () => {
    const store = buildC2paManifestStore();
    const bytes = testCase.build(store, 'none');
    const result = removeCredentials(bytes);
    assert.ok(result.bytesRemoved >= store.length, 'at least the manifest should be gone');
    assert.ok(result.output.length < bytes.length);
  });

  test(`${testCase.name}: running it twice changes nothing the second time`, () => {
    const bytes = testCase.build(buildC2paManifestStore(), 'none');
    const once = removeCredentials(bytes);
    const twice = removeCredentials(once.output);
    assert.equal(twice.outcome, OUTCOME.NOTHING_TO_REMOVE);
    assert.equal(twice.ok, false);
    assert.equal(twice.output, null);
  });
}

test('a manifest split across several JPEG segments is removed in full', () => {
  const bytes = buildJpeg({ c2pa: buildC2paManifestStore({ padding: 150000 }), maxApp11Payload: 60000 });
  const before = jpeg.parseJpegSegments(bytes).segments.filter((s) => s.marker === jpeg.MARKER.APP11);
  assert.ok(before.length > 1, 'fixture should have several APP11 segments');

  const result = removeCredentials(bytes);
  assert.equal(result.ok, true);

  const after = jpeg.parseJpegSegments(result.output).segments.filter((s) => s.marker === jpeg.MARKER.APP11);
  assert.equal(after.length, 0, 'every segment of the manifest must go, not just the first');
});

test('a JUMBF box that is not a C2PA store is left alone', () => {
  // Other standards also use JUMBF boxes in APP11. Those are not ours to touch,
  // so they must survive untouched and must not be reported as credentials.
  const foreign = Buffer.from(buildC2paManifestStore());
  // Break both the UUID prefix and the label so it no longer identifies as C2PA.
  foreign.write('zzzz', foreign.indexOf('c2pa', 12));
  const second = foreign.indexOf('c2pa', 20);
  if (second > 0) foreign.write('zzzz', second);

  const bytes = buildJpeg({ c2pa: new Uint8Array(foreign) });
  const app11Before = jpeg.parseJpegSegments(bytes).segments.filter((s) => s.marker === jpeg.MARKER.APP11);
  assert.ok(app11Before.length > 0, 'fixture should contain an APP11 segment');

  const result = removeCredentials(bytes);
  assert.equal(result.outcome, OUTCOME.NOTHING_TO_REMOVE);
  assert.equal(result.output, null, 'no file is produced when nothing is removed');

  // And the inspector must not claim this foreign box is a credential.
  assert.equal(inspectImage(bytes).c2pa.present, false);
});

test('XMP that links to the credential is removed, and the removal is itemised', () => {
  const bytes = buildPng({ c2pa: buildC2paManifestStore(), xmp: 'provenance' });
  const result = removeCredentials(bytes, { removeXmpProvenanceReference: true });

  assert.equal(result.ok, true);
  const labels = result.removed.map((entry) => entry.label);
  assert.ok(labels.some((label) => /C2PA manifest store/.test(label)));
  assert.ok(labels.some((label) => /XMP/.test(label)));
  // The side effect on other XMP fields must be stated, not hidden.
  const xmpEntry = result.removed.find((entry) => /XMP/.test(entry.label));
  assert.match(xmpEntry.note, /unrelated XMP fields/i);
});

test('XMP that does not link to a credential is left alone', () => {
  const bytes = buildPng({ c2pa: buildC2paManifestStore(), xmp: 'plain' });
  const result = removeCredentials(bytes, { removeXmpProvenanceReference: true });

  assert.equal(result.removed.length, 1);
  assert.match(result.removed[0].label, /C2PA manifest store/);
  assert.ok(inspectImage(result.output).otherMetadata.some((entry) => entry.kind === 'xmp'));
});

test('the XMP setting is honoured when switched off', () => {
  const bytes = buildPng({ c2pa: buildC2paManifestStore(), xmp: 'provenance' });
  const result = removeCredentials(bytes, { removeXmpProvenanceReference: false });

  assert.equal(result.removed.length, 1);
  const after = inspectImage(result.output);
  assert.ok(after.otherMetadata.some((entry) => entry.kind === 'xmp' && entry.hasProvenanceReference));
});

test('an image with no credentials reports nothing-to-remove and returns no file', () => {
  const result = removeCredentials(buildPng());
  assert.equal(result.outcome, OUTCOME.NOTHING_TO_REMOVE);
  assert.equal(result.ok, false);
  assert.equal(result.output, null);
  assert.match(result.message, /nothing to remove/i);
});

test('an unsupported format is refused, not silently converted', () => {
  const gif = concat([Uint8Array.from('GIF89a', (c) => c.charCodeAt(0)), new Uint8Array(64)]);
  const result = removeCredentials(gif);
  assert.equal(result.outcome, OUTCOME.UNSUPPORTED_FORMAT);
  assert.equal(result.output, null);
});

test('a corrupt file is refused rather than producing a broken download', () => {
  const bytes = buildPng();
  bytes.fill(0xff, 8, 24);
  const result = removeCredentials(bytes);
  assert.equal(result.ok, false);
  assert.equal(result.output, null);
});

test('verification fails loudly if the output still contains a manifest', () => {
  // Hand verifyRemoval an "output" that was never cleaned.
  const bytes = buildPng({ c2pa: buildC2paManifestStore() });
  const verification = verifyRemoval(bytes, bytes, FORMAT.PNG);

  assert.equal(verification.ok, false);
  const failed = verification.checks.find((check) => !check.passed);
  assert.match(failed.name, /No supported credentials remain/);
});

test('verification fails if the pixel data changed', () => {
  const original = buildPng({ c2pa: buildC2paManifestStore(), width: 8, height: 8 });
  // A different image of the same size, with the manifest removed: credentials
  // are gone and dimensions match, but the pixels are not the same file.
  const different = removeCredentials(buildPng({ width: 8, height: 8, c2pa: buildC2paManifestStore() })).output;
  const tampered = Buffer.from(different);
  const parsed = png.parsePngChunks(new Uint8Array(tampered));
  const idat = parsed.chunks.find((chunk) => chunk.type === 'IDAT');
  tampered[idat.dataOffset] = tampered[idat.dataOffset] ^ 0xff;

  const verification = verifyRemoval(original, new Uint8Array(tampered), FORMAT.PNG);
  const pixelCheck = verification.checks.find((check) => /Pixel data/.test(check.name));
  assert.equal(pixelCheck.passed, false);
  assert.equal(verification.ok, false);
});
